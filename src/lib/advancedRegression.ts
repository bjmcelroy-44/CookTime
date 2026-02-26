import type { SteakData } from "../types/steak";
import type { ReverseSearCalibrationData } from "../types/reverseSearCalibration";

export type RegressionSource = "starter" | "calibration";

export interface RegressionObservation {
  source: RegressionSource;
  methodId: string;
  ovenMode: string;
  cutClass: string;
  thicknessIn: number;
  ovenTempF: number;
  pullTempF: number;
  estimatedWeightOz: number;
  lowMinutes: number;
  highMinutes: number;
  confidenceWeight: number;
}

export interface RegressionTarget {
  methodId: string;
  ovenMode: string;
  cutClass: string;
  thicknessIn: number;
  ovenTempF: number;
  pullTempF: number;
  estimatedWeightOz: number;
}

export interface RegressionOptions {
  topK?: number;
  preferSource?: RegressionSource;
  sourceBoost?: Partial<Record<RegressionSource, number>>;
}

export interface RegressionPrediction {
  lowMinutes: number;
  highMinutes: number;
  messages: string[];
}

const CONFIDENCE_WEIGHT: Record<string, number> = {
  low: 1,
  medium: 1.12,
  high: 1.25
};

const METHOD_PULL_SLOPE: Record<string, { low: number; high: number }> = {
  sear_then_oven: { low: 0.18, high: 0.28 },
  reverse_sear: { low: 0.45, high: 0.65 },
  broil: { low: 0.12, high: 0.2 }
};

const DEFAULT_MASS_PER_IN_OZ = 9.5;

export interface CutMassContext {
  byCutClass: Record<string, number>;
  globalMassPerInOz: number;
}

export const buildCutMassContext = (data: SteakData): CutMassContext => {
  const buckets = new Map<string, number[]>();

  for (const cut of data.cuts) {
    if (
      typeof cut.typical_weight_oz === "number" &&
      Number.isFinite(cut.typical_weight_oz) &&
      cut.typical_thickness_in > 0
    ) {
      const massPerIn = cut.typical_weight_oz / cut.typical_thickness_in;
      const current = buckets.get(cut.cook_class) ?? [];
      current.push(massPerIn);
      buckets.set(cut.cook_class, current);
    }
  }

  const byCutClass: Record<string, number> = {};
  const allValues: number[] = [];

  for (const [cutClass, values] of buckets.entries()) {
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    byCutClass[cutClass] = avg;
    allValues.push(...values);
  }

  const globalMassPerInOz =
    allValues.length > 0
      ? allValues.reduce((sum, value) => sum + value, 0) / allValues.length
      : DEFAULT_MASS_PER_IN_OZ;

  return {
    byCutClass,
    globalMassPerInOz
  };
};

const resolveMassPerIn = (
  cutClass: string,
  massContext: CutMassContext
): number => massContext.byCutClass[cutClass] ?? massContext.globalMassPerInOz;

export const estimateSelectionWeightOz = (
  data: SteakData,
  cutId: string,
  thicknessIn: number
): number => {
  const cut = data.cuts.find((entry) => entry.cut_id === cutId);
  if (!cut) {
    return DEFAULT_MASS_PER_IN_OZ * thicknessIn;
  }

  if (
    typeof cut.typical_weight_oz === "number" &&
    Number.isFinite(cut.typical_weight_oz) &&
    cut.typical_thickness_in > 0
  ) {
    const massPerIn = cut.typical_weight_oz / cut.typical_thickness_in;
    return Math.max(2, massPerIn * thicknessIn);
  }

  const massContext = buildCutMassContext(data);
  const massPerIn = resolveMassPerIn(cut.cook_class, massContext);
  return Math.max(2, massPerIn * thicknessIn);
};

const roundRange = (low: number, high: number): { low: number; high: number } => {
  const roundedLow = Math.max(1, Math.round(low));
  const roundedHigh = Math.max(roundedLow, Math.round(high));

  return { low: roundedLow, high: roundedHigh };
};

const weightedAverage = <T>(
  rows: T[],
  getWeight: (row: T) => number,
  getValue: (row: T) => number
): number => {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const weight = getWeight(row);
    weightedSum += weight * getValue(row);
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return 0;
  }

  return weightedSum / totalWeight;
};

const calculateDistance = (
  observation: RegressionObservation,
  target: RegressionTarget,
  preferSource?: RegressionSource
): number => {
  const thicknessTerm = Math.abs(observation.thicknessIn - target.thicknessIn) / 0.45;
  const tempTerm = Math.abs(observation.ovenTempF - target.ovenTempF) / 70;
  const pullTerm = Math.abs(observation.pullTempF - target.pullTempF) / 8;
  const massTerm =
    Math.abs(observation.estimatedWeightOz - target.estimatedWeightOz) / 9;

  let categoryPenalty = 0;

  if (observation.methodId !== target.methodId) {
    categoryPenalty += 2.3;
  }

  if (observation.ovenMode !== target.ovenMode) {
    categoryPenalty += 1.1;
  }

  if (observation.cutClass !== target.cutClass) {
    categoryPenalty += 0.9;
  }

  if (preferSource && observation.source !== preferSource) {
    categoryPenalty += 0.4;
  }

  if (observation.source === "calibration" && target.methodId !== "reverse_sear") {
    categoryPenalty += 1.2;
  }

  const squared =
    thicknessTerm * thicknessTerm +
    tempTerm * tempTerm +
    pullTerm * pullTerm +
    massTerm * massTerm +
    categoryPenalty * categoryPenalty;

  return Math.sqrt(squared);
};

const buildWeight = (
  distance: number,
  observation: RegressionObservation,
  target: RegressionTarget,
  options: RegressionOptions
): number => {
  let weight = observation.confidenceWeight * Math.exp(-0.5 * distance * distance);

  if (weight < 1e-6) {
    weight = observation.confidenceWeight / ((distance + 0.35) * (distance + 0.35));
  }

  if (observation.methodId === target.methodId) {
    weight *= 1.35;
  }

  if (observation.ovenMode === target.ovenMode) {
    weight *= 1.15;
  }

  if (observation.cutClass === target.cutClass) {
    weight *= 1.12;
  }

  if (options.sourceBoost?.[observation.source]) {
    weight *= options.sourceBoost[observation.source] ?? 1;
  }

  if (options.preferSource && observation.source === options.preferSource) {
    weight *= 1.15;
  }

  return weight;
};

const applyPullAdjustment = (
  low: number,
  high: number,
  target: RegressionTarget,
  weightedPullF: number
): { low: number; high: number; message: string | null } => {
  const deltaPull = target.pullTempF - weightedPullF;

  if (Math.abs(deltaPull) < 1) {
    return { low, high, message: null };
  }

  const slope = METHOD_PULL_SLOPE[target.methodId] ?? { low: 0.2, high: 0.3 };
  const thicknessFactor = 0.82 + target.thicknessIn * 0.2;

  const adjusted = {
    low: low + deltaPull * slope.low * thicknessFactor,
    high: high + deltaPull * slope.high * thicknessFactor
  };

  return {
    ...adjusted,
    message: `Adjusted for doneness target (${Math.round(target.pullTempF)}F pull) using method-specific thermal regression.`
  };
};

const applyHeatGapExtrapolation = (
  low: number,
  high: number,
  target: RegressionTarget,
  weightedOvenF: number,
  observedTemps: number[]
): { low: number; high: number; message: string | null } => {
  if (observedTemps.length === 0) {
    return { low, high, message: null };
  }

  const minObserved = Math.min(...observedTemps);
  const maxObserved = Math.max(...observedTemps);

  const isOutsideRange = target.ovenTempF < minObserved || target.ovenTempF > maxObserved;
  const farFromCenter = Math.abs(target.ovenTempF - weightedOvenF) > 45;

  if (!isOutsideRange && !farFromCenter) {
    return { low, high, message: null };
  }

  const baseDrive = Math.max(10, weightedOvenF - target.pullTempF);
  const targetDrive = Math.max(10, target.ovenTempF - target.pullTempF);

  let factor = baseDrive / targetDrive;
  const unclamped = factor;
  factor = Math.max(0.45, Math.min(2.6, factor));

  return {
    low: low * factor,
    high: high * factor,
    message:
      factor !== unclamped
        ? `Temperature extrapolation used heat-gap scaling from observed ${Math.round(minObserved)}F-${Math.round(maxObserved)}F data (clamped).`
        : `Temperature extrapolation used heat-gap scaling from observed ${Math.round(minObserved)}F-${Math.round(maxObserved)}F data.`
  };
};

const applyMassAdjustment = (
  low: number,
  high: number,
  target: RegressionTarget,
  weightedMassOz: number
): { low: number; high: number; message: string | null } => {
  if (weightedMassOz <= 0 || target.estimatedWeightOz <= 0) {
    return { low, high, message: null };
  }

  let factor = Math.pow(target.estimatedWeightOz / weightedMassOz, 0.34);
  const unclamped = factor;
  factor = Math.max(0.72, Math.min(1.4, factor));

  if (Math.abs(factor - 1) < 0.03) {
    return { low, high, message: null };
  }

  return {
    low: low * factor,
    high: high * factor,
    message:
      factor !== unclamped
        ? `Adjusted for steak mass-volume profile (weight/thickness) relative to neighborhood data (clamped).`
        : `Adjusted for steak mass-volume profile (weight/thickness) relative to neighborhood data.`
  };
};

const applyUncertaintyWidening = (
  low: number,
  high: number,
  meanDistance: number,
  stdLow: number,
  stdHigh: number
): { low: number; high: number } => {
  const spread = Math.sqrt(Math.max(0, (stdLow * stdLow + stdHigh * stdHigh) / 2));
  const widenMinutes = Math.max(1, meanDistance * 1.6 + spread * 0.35);

  const widenedLow = Math.max(1, low - widenMinutes * 0.2);
  const widenedHigh = Math.max(widenedLow + 1, high + widenMinutes * 0.8);

  return { low: widenedLow, high: widenedHigh };
};

export const buildStarterObservations = (data: SteakData): RegressionObservation[] => {
  const donenessById = new Map(
    data.doneness_targets.map((target) => [target.doneness_id, target])
  );
  const massContext = buildCutMassContext(data);

  return data.cook_time_models.map((model) => {
    const doneness = donenessById.get(model.doneness_id);
    const pullTempF = model.pull_temp_override_f ?? doneness?.pull_temp_f ?? 125;
    const thicknessIn = (model.thickness_in_min + model.thickness_in_max) / 2;
    const massPerIn = resolveMassPerIn(model.cut_class, massContext);

    return {
      source: "starter",
      methodId: model.method_id,
      ovenMode: model.oven_mode,
      cutClass: model.cut_class,
      thicknessIn,
      ovenTempF: model.oven_temp_f,
      pullTempF,
      estimatedWeightOz: Math.max(2, massPerIn * thicknessIn),
      lowMinutes: model.time_min_low,
      highMinutes: model.time_min_high,
      confidenceWeight: CONFIDENCE_WEIGHT[model.confidence] ?? 1
    } satisfies RegressionObservation;
  });
};

export const buildCalibrationObservations = (
  calibrationData: ReverseSearCalibrationData,
  massContext?: CutMassContext
): RegressionObservation[] => {
  const observations: RegressionObservation[] = [];
  const fallbackContext = massContext ?? {
    byCutClass: {},
    globalMassPerInOz: DEFAULT_MASS_PER_IN_OZ
  };

  for (const profile of calibrationData.profiles) {
    const inferred125Low =
      profile.time_to_125_low ??
      profile.time_to_120_low + calibrationData.default_minutes_per_degree.low * 5;
    const inferred125High =
      profile.time_to_125_high ??
      profile.time_to_120_high + calibrationData.default_minutes_per_degree.high * 5;

    for (const cutClass of profile.cut_classes) {
      const massPerIn =
        typeof profile.typical_weight_oz === "number" &&
        Number.isFinite(profile.typical_weight_oz) &&
        profile.thickness_in > 0
          ? profile.typical_weight_oz / profile.thickness_in
          : resolveMassPerIn(cutClass, fallbackContext);
      const estimatedWeightOz = Math.max(2, massPerIn * profile.thickness_in);

      observations.push({
        source: "calibration",
        methodId: "reverse_sear",
        ovenMode: profile.oven_mode,
        cutClass,
        thicknessIn: profile.thickness_in,
        ovenTempF: calibrationData.base_oven_temp_f,
        pullTempF: 120,
        estimatedWeightOz,
        lowMinutes: profile.time_to_120_low,
        highMinutes: profile.time_to_120_high,
        confidenceWeight: 1 + Math.sqrt(Math.max(1, profile.sample_count)) * 0.2
      });

      observations.push({
        source: "calibration",
        methodId: "reverse_sear",
        ovenMode: profile.oven_mode,
        cutClass,
        thicknessIn: profile.thickness_in,
        ovenTempF: calibrationData.base_oven_temp_f,
        pullTempF: 125,
        estimatedWeightOz,
        lowMinutes: inferred125Low,
        highMinutes: inferred125High,
        confidenceWeight: 1 + Math.sqrt(Math.max(1, profile.sample_count)) * 0.2
      });
    }
  }

  return observations;
};

export const predictWithHybridRegression = (
  observations: RegressionObservation[],
  target: RegressionTarget,
  options: RegressionOptions = {}
): RegressionPrediction => {
  const topK = Math.max(4, options.topK ?? 10);

  if (observations.length === 0) {
    return {
      lowMinutes: 1,
      highMinutes: 2,
      messages: ["No historical observations were available; returned minimum safe placeholder range."]
    };
  }

  const rows = observations
    .map((observation) => {
      const distance = calculateDistance(observation, target, options.preferSource);
      const weight = buildWeight(distance, observation, target, options);

      return {
        observation,
        distance,
        weight
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.min(topK, observations.length));

  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);

  const meanLow = weightedAverage(rows, (row) => row.weight, (row) => row.observation.lowMinutes);
  const meanHigh = weightedAverage(rows, (row) => row.weight, (row) => row.observation.highMinutes);
  const weightedPull = weightedAverage(rows, (row) => row.weight, (row) => row.observation.pullTempF);
  const weightedOven = weightedAverage(rows, (row) => row.weight, (row) => row.observation.ovenTempF);
  const weightedMass = weightedAverage(rows, (row) => row.weight, (row) => row.observation.estimatedWeightOz);
  const meanDistance = weightedAverage(rows, (row) => row.weight, (row) => row.distance);

  const stdLow = Math.sqrt(
    Math.max(
      0,
      weightedAverage(rows, (row) => row.weight, (row) => {
        const delta = row.observation.lowMinutes - meanLow;
        return delta * delta;
      })
    )
  );

  const stdHigh = Math.sqrt(
    Math.max(
      0,
      weightedAverage(rows, (row) => row.weight, (row) => {
        const delta = row.observation.highMinutes - meanHigh;
        return delta * delta;
      })
    )
  );

  const methodRows = rows.filter((row) => row.observation.methodId === target.methodId);
  const observedMethodTemps = methodRows.map((row) => row.observation.ovenTempF);

  const pullAdjusted = applyPullAdjustment(meanLow, meanHigh, target, weightedPull);
  const massAdjusted = applyMassAdjustment(
    pullAdjusted.low,
    pullAdjusted.high,
    target,
    weightedMass
  );
  const tempAdjusted = applyHeatGapExtrapolation(
    massAdjusted.low,
    massAdjusted.high,
    target,
    methodRows.length > 0 ? weightedAverage(methodRows, (row) => row.weight, (row) => row.observation.ovenTempF) : weightedOven,
    observedMethodTemps.length > 0 ? observedMethodTemps : rows.map((row) => row.observation.ovenTempF)
  );

  const widened = applyUncertaintyWidening(
    tempAdjusted.low,
    tempAdjusted.high,
    meanDistance,
    stdLow,
    stdHigh
  );

  const rounded = roundRange(widened.low, widened.high);

  const messages = [
    `Hybrid regression blended ${rows.length} nearest observations (weighted k-NN + local heat-gap scaling).`
  ];

  if (pullAdjusted.message) {
    messages.push(pullAdjusted.message);
  }

  if (massAdjusted.message) {
    messages.push(massAdjusted.message);
  }

  if (tempAdjusted.message) {
    messages.push(tempAdjusted.message);
  }

  if (totalWeight <= 0.25) {
    messages.push("Very sparse neighborhood for this combination; uncertainty expanded.");
  }

  return {
    lowMinutes: rounded.low,
    highMinutes: rounded.high,
    messages
  };
};
