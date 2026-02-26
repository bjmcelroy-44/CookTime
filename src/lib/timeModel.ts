import {
  buildStarterObservations,
  estimateSelectionWeightOz,
  predictWithHybridRegression
} from "./advancedRegression";
import type {
  CookTimeModel,
  DonenessTarget,
  SteakData,
  TimeAdjustment
} from "../types/steak";

const CONFIDENCE_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3
};

export type StartTempAssumption = "fridge" | "tempered";

export interface EstimatorInputs {
  cutId: string;
  donenessId: string;
  thicknessIn: number;
  weightOz?: number;
  ovenTempF: number;
  ovenMode: string;
  methodId: string;
  startTempAssumption?: StartTempAssumption;
}

export interface EstimateSuccess {
  status: "ok";
  timeRangeMinutes: {
    low: number;
    high: number;
  };
  pullTempF: number;
  restMinutes: number;
  instruction: string;
  isApproximateTemp: boolean;
  requestedOvenTempF: number;
  modelOvenTempF: number;
  matchedModel?: CookTimeModel;
  appliedAdjustments: TimeAdjustment[];
  messages?: string[];
}

export interface EstimateError {
  status: "error";
  message: string;
}

export type EstimateResult = EstimateSuccess | EstimateError;

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const getConfidenceRank = (confidence: string): number =>
  CONFIDENCE_RANK[confidence] ?? 0;

const modelWidth = (model: CookTimeModel): number =>
  model.thickness_in_max - model.thickness_in_min;

const pickBestModel = (
  models: CookTimeModel[],
  requestedOvenTempF: number
): CookTimeModel => {
  const sorted = [...models].sort((a, b) => {
    const widthDiff = modelWidth(a) - modelWidth(b);
    if (widthDiff !== 0) {
      return widthDiff;
    }

    const confidenceDiff =
      getConfidenceRank(b.confidence) - getConfidenceRank(a.confidence);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }

    const tempDistanceDiff =
      Math.abs(a.oven_temp_f - requestedOvenTempF) -
      Math.abs(b.oven_temp_f - requestedOvenTempF);
    if (tempDistanceDiff !== 0) {
      return tempDistanceDiff;
    }

    return a.model_id.localeCompare(b.model_id);
  });

  return sorted[0];
};

const contextMatches = (
  appliesTo: Record<string, string | number | boolean | undefined>,
  context: Record<string, string | number | boolean | undefined>
): boolean =>
  Object.entries(appliesTo).every(([key, value]) => context[key] === value);

const applyAdjustments = (
  baseLow: number,
  baseHigh: number,
  adjustments: TimeAdjustment[],
  context: Record<string, string | number | boolean | undefined>
): { low: number; high: number; applied: TimeAdjustment[] } => {
  let low = baseLow;
  let high = baseHigh;
  const applied: TimeAdjustment[] = [];

  const ordered = [...adjustments].sort((a, b) => a.priority - b.priority);

  for (const adjustment of ordered) {
    if (!contextMatches(adjustment.applies_to, context)) {
      continue;
    }

    if (isFiniteNumber(adjustment.factor)) {
      low *= adjustment.factor;
      high *= adjustment.factor;
    }

    if (isFiniteNumber(adjustment.delta_minutes)) {
      low += adjustment.delta_minutes;
      high += adjustment.delta_minutes;
    }

    applied.push(adjustment);
  }

  return { low, high, applied };
};

const resolvePullTemp = (model: CookTimeModel, doneness: DonenessTarget): number =>
  isFiniteNumber(model.pull_temp_override_f)
    ? model.pull_temp_override_f
    : doneness.pull_temp_f;

const resolveRestMinutes = (model: CookTimeModel, doneness: DonenessTarget): number =>
  isFiniteNumber(model.rest_minutes_override)
    ? model.rest_minutes_override
    : doneness.rest_minutes_default;

const roundRange = (low: number, high: number): { low: number; high: number } => {
  const roundedLow = Math.max(1, Math.round(low));
  const roundedHigh = Math.max(roundedLow, Math.round(high));

  return {
    low: roundedLow,
    high: roundedHigh
  };
};

const resolveInputWeightOz = (data: SteakData, inputs: EstimatorInputs): number => {
  if (
    typeof inputs.weightOz === "number" &&
    Number.isFinite(inputs.weightOz) &&
    inputs.weightOz > 0
  ) {
    return inputs.weightOz;
  }

  return estimateSelectionWeightOz(data, inputs.cutId, inputs.thicknessIn);
};

const scaleApproximateDirectRangeForTemperature = (
  low: number,
  high: number,
  modelOvenTempF: number,
  requestedOvenTempF: number,
  pullTempF: number,
  methodId: string
): { low: number; high: number; message: string } => {
  const sourceDrive = Math.max(12, modelOvenTempF - pullTempF);
  const targetDrive = Math.max(12, requestedOvenTempF - pullTempF);

  let factor = sourceDrive / targetDrive;
  const unclamped = factor;

  const methodClamp =
    methodId === "sear_then_oven" ? { min: 0.58, max: 3.3 } : { min: 0.5, max: 2.8 };
  factor = Math.max(methodClamp.min, Math.min(methodClamp.max, factor));

  // Sear-then-oven rows were calibrated at hotter finishing temps, so low oven requests need
  // additional slowdown beyond pure heat-gap scaling.
  const lowTempPenalty =
    methodId === "sear_then_oven" && requestedOvenTempF < 350
      ? 1 + (350 - requestedOvenTempF) / 700
      : 1;

  const scaledFactor = factor * lowTempPenalty;

  const scaled = {
    low: low * scaledFactor,
    high: high * scaledFactor
  };

  const clampNote = factor !== unclamped ? " (clamped)" : "";
  const penaltyNote =
    lowTempPenalty > 1
      ? " with additional low-temp slowdown for sear_then_oven"
      : "";

  return {
    ...scaled,
    message: `Scaled nearest-row timing from ${modelOvenTempF}F to ${requestedOvenTempF}F using heat-gap regression${clampNote}${penaltyNote}.`
  };
};

const buildInstruction = (
  inputs: EstimatorInputs,
  lowMinutes: number,
  highMinutes: number,
  pullTempF: number,
  restMinutes: number,
  searSecondsPerSide?: number
): string => {
  const range = `${lowMinutes}-${highMinutes} min`;
  const tempText = `${inputs.ovenTempF}F`;

  switch (inputs.methodId) {
    case "sear_then_oven": {
      const searSeconds = searSecondsPerSide ?? 90;
      return `Sear ${searSeconds}s/side, then oven ${range} at ${tempText}. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
    }
    case "reverse_sear": {
      const searSeconds = searSecondsPerSide ?? 60;
      return `Oven ${range} at ${tempText}, then sear ${searSeconds}s/side. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
    }
    case "broil":
      return `Broil ${range} at ${tempText}, flipping once midway. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
    default:
      return `Cook for ${range} at ${tempText}. Pull at ${pullTempF}F, rest ${restMinutes} min.`;
  }
};

export const resolveCookEstimate = (
  data: SteakData,
  inputs: EstimatorInputs
): EstimateResult => {
  const cut = data.cuts.find((entry) => entry.cut_id === inputs.cutId);
  if (!cut) {
    return { status: "error", message: "Select a valid steak cut to estimate cook time." };
  }

  const method = data.methods.find((entry) => entry.method_id === inputs.methodId);
  if (!method) {
    return {
      status: "error",
      message: "Select a valid cooking method to estimate cook time."
    };
  }

  const doneness = data.doneness_targets.find(
    (entry) => entry.doneness_id === inputs.donenessId
  );
  if (!doneness) {
    return {
      status: "error",
      message: "Select a valid doneness level to estimate cook time."
    };
  }

  const baseCandidates = data.cook_time_models.filter((model) => {
    const withinThickness =
      inputs.thicknessIn >= model.thickness_in_min &&
      inputs.thicknessIn <= model.thickness_in_max;

    return (
      model.cut_class === cut.cook_class &&
      model.method_id === inputs.methodId &&
      model.oven_mode === inputs.ovenMode &&
      model.doneness_id === inputs.donenessId &&
      withinThickness
    );
  });

  const exactTempCandidates = baseCandidates.filter(
    (model) => model.oven_temp_f === inputs.ovenTempF
  );

  let selectedModel: CookTimeModel | undefined;
  let isApproximateTemp = false;

  if (exactTempCandidates.length > 0) {
    selectedModel = pickBestModel(exactTempCandidates, inputs.ovenTempF);
  } else if (baseCandidates.length > 0) {
    isApproximateTemp = true;

    const nearestDistance = Math.min(
      ...baseCandidates.map((model) =>
        Math.abs(model.oven_temp_f - inputs.ovenTempF)
      )
    );

    const nearest = baseCandidates.filter(
      (model) => Math.abs(model.oven_temp_f - inputs.ovenTempF) === nearestDistance
    );

    selectedModel = pickBestModel(nearest, inputs.ovenTempF);
  }

  const baseContext: Record<string, string | number | boolean | undefined> = {
    cut_class: cut.cook_class,
    method_id: inputs.methodId,
    doneness_id: inputs.donenessId,
    oven_mode: inputs.ovenMode,
    oven_temp_f: inputs.ovenTempF,
    start_temp_assumption: inputs.startTempAssumption,
    pan_assumption: method.default_pan
  };

  const regressionObservations = buildStarterObservations(data);
  const regressionTargetPull = doneness.pull_temp_f;
  const estimatedWeightOz = resolveInputWeightOz(data, inputs);

  const regression = predictWithHybridRegression(
    regressionObservations,
    {
      methodId: inputs.methodId,
      ovenMode: inputs.ovenMode,
      cutClass: cut.cook_class,
      thicknessIn: inputs.thicknessIn,
      ovenTempF: inputs.ovenTempF,
      pullTempF: regressionTargetPull,
      estimatedWeightOz
    },
    {
      topK: 9,
      preferSource: "starter",
      sourceBoost: {
        starter: 1.2
      }
    }
  );

  const regressionAdjusted = applyAdjustments(
    regression.lowMinutes,
    regression.highMinutes,
    data.time_adjustments,
    baseContext
  );

  let finalLow = regressionAdjusted.low;
  let finalHigh = regressionAdjusted.high;
  let pullTempF = doneness.pull_temp_f;
  let restMinutes = doneness.rest_minutes_default;
  const messages = [...regression.messages];
  let appliedAdjustments = regressionAdjusted.applied;

  if (selectedModel) {
    const modelContext: Record<string, string | number | boolean | undefined> = {
      ...baseContext,
      oven_temp_f: selectedModel.oven_temp_f,
      pan_assumption: selectedModel.pan_assumption ?? method.default_pan
    };

    const directAdjusted = applyAdjustments(
      selectedModel.time_min_low,
      selectedModel.time_min_high,
      data.time_adjustments,
      modelContext
    );

    let directLow = directAdjusted.low;
    let directHigh = directAdjusted.high;

    const directWeight = isApproximateTemp ? 0.58 : 0.76;
    const regressionWeight = 1 - directWeight;

    const modelPullTempF = resolvePullTemp(selectedModel, doneness);

    if (isApproximateTemp) {
      const scaledApproximate = scaleApproximateDirectRangeForTemperature(
        directLow,
        directHigh,
        selectedModel.oven_temp_f,
        inputs.ovenTempF,
        modelPullTempF,
        inputs.methodId
      );

      directLow = scaledApproximate.low;
      directHigh = scaledApproximate.high;
      messages.unshift(scaledApproximate.message);
    }

    finalLow =
      directLow * directWeight + regressionAdjusted.low * regressionWeight;
    finalHigh =
      directHigh * directWeight + regressionAdjusted.high * regressionWeight;

    pullTempF = modelPullTempF;
    restMinutes = resolveRestMinutes(selectedModel, doneness);

    appliedAdjustments = directAdjusted.applied;

    if (isApproximateTemp) {
      messages.unshift(
        `Approximate: no exact model at ${inputs.ovenTempF}F. Using nearest direct model at ${selectedModel.oven_temp_f}F plus regression blending.`
      );
    } else {
      messages.unshift(
        "Used direct starter row and blended with weighted regression for stability."
      );
    }
  } else {
    isApproximateTemp = true;
    messages.unshift(
      "No direct starter row for this exact combo, so this estimate is fully regression-extrapolated."
    );
  }

  const rounded = roundRange(finalLow, finalHigh);
  const instruction = buildInstruction(
    inputs,
    rounded.low,
    rounded.high,
    pullTempF,
    restMinutes,
    selectedModel?.sear_seconds_per_side ?? undefined
  );

  return {
    status: "ok",
    timeRangeMinutes: rounded,
    pullTempF,
    restMinutes,
    instruction,
    isApproximateTemp,
    requestedOvenTempF: inputs.ovenTempF,
    modelOvenTempF: selectedModel?.oven_temp_f ?? inputs.ovenTempF,
    matchedModel: selectedModel,
    appliedAdjustments,
    messages
  };
};
