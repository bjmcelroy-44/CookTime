import {
  buildCalibrationObservations,
  buildCutMassContext,
  estimateSelectionWeightOz,
  predictWithHybridRegression
} from "./advancedRegression";
import type { EstimatorInputs } from "./timeModel";
import type { SteakData } from "../types/steak";
import type {
  ReverseSearCalibrationData,
  ReverseSearCalibrationPoint
} from "../types/reverseSearCalibration";
import type { UiEstimateResult } from "../types/estimate";

const CONVECTION_FACTOR = 0.9;
const DEFAULT_REVERSE_SEAR_SECONDS_PER_SIDE = 60;

interface PullRange {
  low: number;
  high: number;
}

interface ThermalCoefficients {
  kFast: number;
  kSlow: number;
  baselineStartTempF: number;
  baselineOvenActualF: number;
}

const DEFAULT_BASELINE_START_F = 41;
const DEFAULT_BAKE_ACTUAL_RATIO = 0.9;
const DEFAULT_CONVECTION_ACTUAL_RATIO = 0.945;

const roundRange = (low: number, high: number): { low: number; high: number } => {
  const roundedLow = Math.max(1, Math.round(low));
  const roundedHigh = Math.max(roundedLow, Math.round(high));

  return {
    low: roundedLow,
    high: roundedHigh
  };
};

const resolveInputWeightOz = (starterData: SteakData, inputs: EstimatorInputs): number => {
  if (
    typeof inputs.weightOz === "number" &&
    Number.isFinite(inputs.weightOz) &&
    inputs.weightOz > 0
  ) {
    return inputs.weightOz;
  }

  return estimateSelectionWeightOz(starterData, inputs.cutId, inputs.thicknessIn);
};

const applySpecializedWeightAdjustment = (
  range: PullRange,
  starterData: SteakData,
  inputs: EstimatorInputs
): { range: PullRange; message?: string } => {
  if (
    typeof inputs.weightOz !== "number" ||
    !Number.isFinite(inputs.weightOz) ||
    inputs.weightOz <= 0
  ) {
    return { range };
  }

  const baselineWeightOz = estimateSelectionWeightOz(
    starterData,
    inputs.cutId,
    inputs.thicknessIn
  );

  if (!Number.isFinite(baselineWeightOz) || baselineWeightOz <= 0) {
    return { range };
  }

  let factor = Math.pow(inputs.weightOz / baselineWeightOz, 0.34);
  const unclamped = factor;
  factor = Math.max(0.72, Math.min(1.4, factor));

  if (Math.abs(factor - 1) < 0.03) {
    return { range };
  }

  return {
    range: {
      low: range.low * factor,
      high: range.high * factor
    },
    message:
      factor !== unclamped
        ? "Adjusted thermal profile for custom steak weight/volume (clamped)."
        : "Adjusted thermal profile for custom steak weight/volume."
  };
};

const deriveThermalCoefficients = (
  profile: ReverseSearCalibrationPoint,
  calibrationData: ReverseSearCalibrationData
): ThermalCoefficients | null => {
  const has125 =
    profile.time_to_125_low !== null && profile.time_to_125_high !== null;
  const targetTempF = has125 ? 125 : 120;
  const fastTime = has125 ? profile.time_to_125_low : profile.time_to_120_low;
  const slowTime = has125 ? profile.time_to_125_high : profile.time_to_120_high;

  if (
    fastTime === null ||
    slowTime === null ||
    fastTime <= 0 ||
    slowTime <= 0
  ) {
    return null;
  }

  const baselineStartTempF = profile.start_temp_f ?? DEFAULT_BASELINE_START_F;
  const defaultRatio =
    profile.oven_mode === "convection"
      ? DEFAULT_CONVECTION_ACTUAL_RATIO
      : DEFAULT_BAKE_ACTUAL_RATIO;
  const baselineOvenActualF =
    profile.oven_actual_f ?? calibrationData.base_oven_temp_f * defaultRatio;

  if (
    baselineOvenActualF <= targetTempF + 8 ||
    baselineOvenActualF <= baselineStartTempF + 8
  ) {
    return null;
  }

  const numerator = Math.log(
    (baselineOvenActualF - baselineStartTempF) /
      (baselineOvenActualF - targetTempF)
  );

  if (!Number.isFinite(numerator) || numerator <= 0) {
    return null;
  }

  const faster = Math.min(fastTime, slowTime);
  const slower = Math.max(fastTime, slowTime);

  const kFast = numerator / faster;
  const kSlow = numerator / slower;

  if (!Number.isFinite(kFast) || !Number.isFinite(kSlow) || kSlow <= 0) {
    return null;
  }

  return {
    kFast: Math.max(kFast, kSlow),
    kSlow: Math.min(kFast, kSlow),
    baselineStartTempF,
    baselineOvenActualF
  };
};

const interpolateThermalCoefficients = (
  profiles: ReverseSearCalibrationPoint[],
  thicknessIn: number,
  calibrationData: ReverseSearCalibrationData
): { coeff: ThermalCoefficients; message?: string } | null => {
  const points = profiles
    .map((profile) => {
      const coeff = deriveThermalCoefficients(profile, calibrationData);
      if (!coeff) {
        return null;
      }

      return {
        thickness: profile.thickness_in,
        coeff
      };
    })
    .filter((entry): entry is { thickness: number; coeff: ThermalCoefficients } =>
      entry !== null
    )
    .sort((a, b) => a.thickness - b.thickness);

  if (points.length === 0) {
    return null;
  }

  const exact = points.find((entry) => entry.thickness === thicknessIn);
  if (exact) {
    return { coeff: exact.coeff };
  }

  const lower = [...points].reverse().find((entry) => entry.thickness < thicknessIn);
  const upper = points.find((entry) => entry.thickness > thicknessIn);

  if (lower && upper) {
    const ratio = (thicknessIn - lower.thickness) / (upper.thickness - lower.thickness);

    return {
      coeff: {
        kFast: lower.coeff.kFast + (upper.coeff.kFast - lower.coeff.kFast) * ratio,
        kSlow: lower.coeff.kSlow + (upper.coeff.kSlow - lower.coeff.kSlow) * ratio,
        baselineStartTempF:
          lower.coeff.baselineStartTempF +
          (upper.coeff.baselineStartTempF - lower.coeff.baselineStartTempF) * ratio,
        baselineOvenActualF:
          lower.coeff.baselineOvenActualF +
          (upper.coeff.baselineOvenActualF - lower.coeff.baselineOvenActualF) * ratio
      },
      message: `Interpolated thickness between ${lower.thickness.toFixed(2)}in and ${upper.thickness.toFixed(2)}in calibration rows using thermal-rate fit.`
    };
  }

  const nearest = points
    .map((entry) => ({
      ...entry,
      distance: Math.abs(entry.thickness - thicknessIn)
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  return {
    coeff: nearest.coeff,
    message: `Extrapolated thickness from nearest calibration row (${nearest.thickness.toFixed(2)}in) using thermal-rate fit.`
  };
};

const convertThermalForMode = (
  coeff: ThermalCoefficients,
  sourceMode: "bake" | "convection",
  selectedMode: string
): { coeff: ThermalCoefficients; message?: string } => {
  const targetMode = selectedMode === "convection" ? "convection" : "bake";

  if (sourceMode === targetMode) {
    return { coeff };
  }

  if (sourceMode === "bake" && targetMode === "convection") {
    return {
      coeff: {
        ...coeff,
        kFast: coeff.kFast / CONVECTION_FACTOR,
        kSlow: coeff.kSlow / CONVECTION_FACTOR,
        baselineOvenActualF: coeff.baselineOvenActualF * 1.02
      },
      message:
        "No exact convection calibration rows for this cut; converted bake thermal rates using convection speed-up."
    };
  }

  return {
    coeff: {
      ...coeff,
      kFast: coeff.kFast * CONVECTION_FACTOR,
      kSlow: coeff.kSlow * CONVECTION_FACTOR,
      baselineOvenActualF: coeff.baselineOvenActualF * 0.98
    },
    message:
      "No exact bake calibration rows for this cut; converted convection thermal rates using bake slowdown."
  };
};

const predictRangeFromThermalCoefficients = (
  coeff: ThermalCoefficients,
  calibrationData: ReverseSearCalibrationData,
  inputs: EstimatorInputs,
  pullTempF: number
): { range: PullRange; messages: string[] } | null => {
  const messages: string[] = [];
  const ovenActualRatio = coeff.baselineOvenActualF / calibrationData.base_oven_temp_f;
  const estimatedOvenActualF = Math.max(
    pullTempF + 8,
    inputs.ovenTempF * ovenActualRatio
  );

  const baselineStart = coeff.baselineStartTempF;
  const selectedStartTempF =
    inputs.startTempAssumption === "tempered"
      ? Math.min(pullTempF - 8, baselineStart + 18)
      : baselineStart;

  if (selectedStartTempF >= pullTempF - 5) {
    return null;
  }

  const logTerm = Math.log(
    (estimatedOvenActualF - selectedStartTempF) /
      (estimatedOvenActualF - pullTempF)
  );

  if (!Number.isFinite(logTerm) || logTerm <= 0) {
    return null;
  }

  let low = logTerm / coeff.kFast;
  let high = logTerm / coeff.kSlow;

  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) {
    return null;
  }

  const deltaFromBase = Math.abs(inputs.ovenTempF - calibrationData.base_oven_temp_f);
  if (deltaFromBase > 60) {
    const widen = 1 + (deltaFromBase - 60) / 260;
    low *= 1 + (widen - 1) * 0.35;
    high *= widen;
    messages.push(
      `Expanded uncertainty for ${inputs.ovenTempF}F because calibration runs were centered at ${calibrationData.base_oven_temp_f}F.`
    );
  }

  messages.push(
    `Modeled per-degree temperature rise with cut/thickness thermal coefficients (k-fast ${coeff.kFast.toFixed(4)}, k-slow ${coeff.kSlow.toFixed(4)}).`
  );

  return {
    range: {
      low: Math.max(1, low),
      high: Math.max(low, high)
    },
    messages
  };
};

const applyStartTempAdjustment = (
  range: PullRange,
  startTempAssumption: EstimatorInputs["startTempAssumption"]
): { range: PullRange; message?: string } => {
  if (startTempAssumption !== "tempered") {
    return { range };
  }

  return {
    range: {
      low: range.low * 0.85,
      high: range.high * 0.85
    },
    message: "Adjusted for tempered start using 0.85 time factor."
  };
};

const buildInstruction = (
  methodId: string,
  ovenTempF: number,
  lowMinutes: number,
  pullTempF: number,
  restMinutes: number
): string => {
  const lowOnly = `${lowMinutes}`;

  switch (methodId) {
    case "reverse_sear":
      return `Reverse sear: place steak on a wire cooling rack over a sheet pan, oven about ${lowOnly} min at ${ovenTempF}F, then sear ${DEFAULT_REVERSE_SEAR_SECONDS_PER_SIDE}s/side. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
    case "sear_then_oven":
      return `Sear 90s/side, then oven about ${lowOnly} min at ${ovenTempF}F. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
    case "broil":
      return `Broil about ${lowOnly} min at ${ovenTempF}F, flip once midway. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
    default:
      return `Cook about ${lowOnly} min at ${ovenTempF}F. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
  }
};

const regressionFallback = (
  starterData: SteakData,
  calibrationData: ReverseSearCalibrationData,
  inputs: EstimatorInputs,
  reason: string,
  pullTempF: number,
  restMinutes: number,
  cutClass: string
): UiEstimateResult => {
  const massContext = buildCutMassContext(starterData);
  const observations = buildCalibrationObservations(calibrationData, massContext);
  const estimatedWeightOz = resolveInputWeightOz(starterData, inputs);

  const prediction = predictWithHybridRegression(
    observations,
    {
      methodId: inputs.methodId,
      ovenMode: inputs.ovenMode,
      cutClass,
      thicknessIn: inputs.thicknessIn,
      ovenTempF: inputs.ovenTempF,
      pullTempF,
      estimatedWeightOz
    },
    {
      topK: 12,
      preferSource: "calibration",
      sourceBoost: {
        calibration: 1.35
      }
    }
  );

  const startAdjusted = applyStartTempAdjustment(
    {
      low: prediction.lowMinutes,
      high: prediction.highMinutes
    },
    inputs.startTempAssumption
  );

  const rounded = roundRange(startAdjusted.range.low, startAdjusted.range.high);

  const messages = [reason, ...prediction.messages];
  if (startAdjusted.message) {
    messages.push(startAdjusted.message);
  }

  return {
    status: "ok",
    timeRangeMinutes: rounded,
    pullTempF,
    restMinutes,
    instruction: buildInstruction(
      inputs.methodId,
      inputs.ovenTempF,
      rounded.low,
      pullTempF,
      restMinutes
    ),
    messages
  };
};

const specializedReverseSearRange = (
  calibrationData: ReverseSearCalibrationData,
  inputs: EstimatorInputs,
  pullTempF: number,
  cutClass: string
): { range: PullRange; messages: string[] } | null => {
  if (inputs.methodId !== "reverse_sear") {
    return null;
  }

  if (inputs.ovenMode === "broil") {
    return null;
  }

  const pointsForCut = calibrationData.profiles.filter((profile) =>
    profile.cut_classes.includes(cutClass)
  );

  if (pointsForCut.length === 0) {
    return null;
  }

  const messages = [
    `Calibrated from ${calibrationData.source} reverse-sear runs at ${calibrationData.base_oven_temp_f}F.`
  ];

  const wantedMode = inputs.ovenMode === "convection" ? "convection" : "bake";
  const modePoints = pointsForCut.filter((profile) => profile.oven_mode === wantedMode);

  let selectedModePoints = modePoints;
  let sourceMode: "bake" | "convection" = wantedMode;

  if (selectedModePoints.length === 0) {
    const bakePoints = pointsForCut.filter((profile) => profile.oven_mode === "bake");
    const convectionPoints = pointsForCut.filter(
      (profile) => profile.oven_mode === "convection"
    );

    const fallback = [
      { mode: "bake" as const, profiles: bakePoints },
      { mode: "convection" as const, profiles: convectionPoints }
    ]
      .filter((entry) => entry.profiles.length > 0)
      .sort((a, b) => {
        const distanceA = Math.min(
          ...a.profiles.map((profile) => Math.abs(profile.thickness_in - inputs.thicknessIn))
        );
        const distanceB = Math.min(
          ...b.profiles.map((profile) => Math.abs(profile.thickness_in - inputs.thicknessIn))
        );

        return distanceA - distanceB;
      })[0];

    selectedModePoints = fallback.profiles;
    sourceMode = fallback.mode;
    messages.push(
      `No exact ${inputs.ovenMode} calibration rows for this cut; using ${sourceMode} rows with mode conversion.`
    );
  }

  const thicknessSelection = interpolateThermalCoefficients(
    selectedModePoints,
    inputs.thicknessIn,
    calibrationData
  );

  if (!thicknessSelection) {
    return null;
  }

  if (thicknessSelection.message) {
    messages.push(thicknessSelection.message);
  }

  const modeConverted = convertThermalForMode(
    thicknessSelection.coeff,
    sourceMode,
    inputs.ovenMode
  );
  if (modeConverted.message) {
    messages.push(modeConverted.message);
  }

  const thermalPrediction = predictRangeFromThermalCoefficients(
    modeConverted.coeff,
    calibrationData,
    inputs,
    pullTempF
  );

  if (!thermalPrediction) {
    return null;
  }

  messages.push(...thermalPrediction.messages);

  return {
    range: thermalPrediction.range,
    messages
  };
};

export const resolveReverseSearCalibrationEstimate = (
  starterData: SteakData,
  calibrationData: ReverseSearCalibrationData,
  inputs: EstimatorInputs
): UiEstimateResult => {
  const cut = starterData.cuts.find((entry) => entry.cut_id === inputs.cutId);
  if (!cut) {
    return {
      status: "error",
      message: "Select a valid steak cut for calibrated timing."
    };
  }

  const doneness = starterData.doneness_targets.find(
    (entry) => entry.doneness_id === inputs.donenessId
  );
  if (!doneness) {
    return {
      status: "error",
      message: "Select a valid doneness level for calibrated timing."
    };
  }

  const pullTempF = doneness.pull_temp_f;
  const restMinutes = doneness.rest_minutes_default;

  const specialized = specializedReverseSearRange(
    calibrationData,
    inputs,
    pullTempF,
    cut.cook_class
  );

  const regression = regressionFallback(
    starterData,
    calibrationData,
    inputs,
    "Calibration regression filled this combination using reverse-sear sheet observations only.",
    pullTempF,
    restMinutes,
    cut.cook_class
  );

  if (regression.status === "error") {
    return regression;
  }

  let baseResult: Extract<UiEstimateResult, { status: "ok" }>;

  if (!specialized) {
    baseResult = regression;
  } else {
    const weightAdjustedSpecialized = applySpecializedWeightAdjustment(
      specialized.range,
      starterData,
      inputs
    );

    const blendWeightSpecialized = 0.72;
    const blendWeightRegression = 1 - blendWeightSpecialized;

    const blendedLow =
      weightAdjustedSpecialized.range.low * blendWeightSpecialized +
      regression.timeRangeMinutes.low * blendWeightRegression;
    const blendedHigh =
      weightAdjustedSpecialized.range.high * blendWeightSpecialized +
      regression.timeRangeMinutes.high * blendWeightRegression;

    const rounded = roundRange(blendedLow, blendedHigh);

    baseResult = {
      status: "ok",
      timeRangeMinutes: rounded,
      pullTempF,
      restMinutes,
      instruction: buildInstruction(
        inputs.methodId,
        inputs.ovenTempF,
        rounded.low,
        pullTempF,
        restMinutes
      ),
      messages: [
        ...specialized.messages,
        ...(weightAdjustedSpecialized.message
          ? [weightAdjustedSpecialized.message]
          : []),
        "Blended with calibration-only hybrid regression to stabilize sparse regions and cover every combination.",
        ...(regression.messages ?? []).slice(1)
      ]
    };
  }

  if (inputs.ovenMode !== "convection") {
    return baseResult;
  }

  const bakeComparison = resolveReverseSearCalibrationEstimate(
    starterData,
    calibrationData,
    {
      ...inputs,
      ovenMode: "bake"
    }
  );

  if (bakeComparison.status === "error") {
    return baseResult;
  }

  const alreadyFaster =
    baseResult.timeRangeMinutes.low < bakeComparison.timeRangeMinutes.low &&
    baseResult.timeRangeMinutes.high < bakeComparison.timeRangeMinutes.high;

  if (alreadyFaster) {
    return baseResult;
  }

  let lowCap = Math.max(
    1,
    Math.round(bakeComparison.timeRangeMinutes.low * CONVECTION_FACTOR)
  );
  let highCap = Math.max(
    1,
    Math.round(bakeComparison.timeRangeMinutes.high * CONVECTION_FACTOR)
  );

  if (
    bakeComparison.timeRangeMinutes.low > 1 &&
    lowCap >= bakeComparison.timeRangeMinutes.low
  ) {
    lowCap = bakeComparison.timeRangeMinutes.low - 1;
  }
  if (
    bakeComparison.timeRangeMinutes.high > 1 &&
    highCap >= bakeComparison.timeRangeMinutes.high
  ) {
    highCap = bakeComparison.timeRangeMinutes.high - 1;
  }

  const adjusted = roundRange(
    Math.min(baseResult.timeRangeMinutes.low, lowCap),
    Math.min(baseResult.timeRangeMinutes.high, Math.max(lowCap, highCap))
  );

  return {
    ...baseResult,
    timeRangeMinutes: adjusted,
    instruction: buildInstruction(
      inputs.methodId,
      inputs.ovenTempF,
      adjusted.low,
      pullTempF,
      restMinutes
    ),
    messages: [
      ...(baseResult.messages ?? []),
      "Applied convection guardrail so this estimate is not slower than the same setup in bake mode."
    ]
  };
};
