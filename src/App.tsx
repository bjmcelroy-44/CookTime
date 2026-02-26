import { useMemo, useState } from "react";
import InputCard from "./components/InputCard";
import ResultCard from "./components/ResultCard";
import { type EstimatorInputs } from "./lib/timeModel";
import { estimateSelectionWeightOz } from "./lib/advancedRegression";
import { resolveReverseSearCalibrationEstimate } from "./lib/reverseSearCalibration";
import type { SteakData } from "./types/steak";
import type { ReverseSearCalibrationData } from "./types/reverseSearCalibration";
import steakDataJson from "./assets/steak_time_starter.json";
import reverseSearCalibrationJson from "./assets/reverse_sear_calibration.json";

const data = steakDataJson as SteakData;
const reverseSearCalibrationData =
  reverseSearCalibrationJson as ReverseSearCalibrationData;

const COMMON_OVEN_TEMPS = Array.from({ length: 11 }, (_, index) => 250 + index * 25);
const REVERSE_SEAR_OVEN_MODES = data.enums.oven_mode.filter(
  (mode) => mode === "bake" || mode === "convection"
);

const getDefaultMethodId = (): string => {
  if (data.methods.some((method) => method.method_id === "reverse_sear")) {
    return "reverse_sear";
  }

  return data.methods[0]?.method_id ?? "";
};

const getDefaultDonenessId = (): string => {
  if (data.doneness_targets.some((target) => target.doneness_id === "med_rare")) {
    return "med_rare";
  }

  return data.doneness_targets[0]?.doneness_id ?? "";
};

const getDefaultOvenMode = (): string => {
  if (REVERSE_SEAR_OVEN_MODES.includes("bake")) {
    return "bake";
  }

  return REVERSE_SEAR_OVEN_MODES[0] ?? "bake";
};

const getDefaultInputs = (): EstimatorInputs => ({
  cutId: data.cuts[0]?.cut_id ?? "",
  donenessId: getDefaultDonenessId(),
  thicknessIn: Math.min(2.5, Math.max(0.5, data.cuts[0]?.typical_thickness_in ?? 1.25)),
  ovenTempF: 250,
  ovenMode: getDefaultOvenMode(),
  methodId: getDefaultMethodId(),
  startTempAssumption: "fridge"
});

export default function App() {
  const [values, setValues] = useState<EstimatorInputs>(getDefaultInputs);

  const defaultWeightOz = useMemo(
    () => estimateSelectionWeightOz(data, values.cutId, values.thicknessIn),
    [values.cutId, values.thicknessIn]
  );

  const calibratedResult = useMemo(
    () =>
      resolveReverseSearCalibrationEstimate(
        data,
        reverseSearCalibrationData,
        values
      ),
    [values]
  );

  const handleChange = (changes: Partial<EstimatorInputs>): void => {
    setValues((current) => ({
      ...current,
      ...changes,
      methodId: "reverse_sear"
    }));
  };

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1080px]">
        <header className="hero-panel mb-5 sm:mb-6">
          <p className="hero-kicker">Fire Up The Oven</p>
          <h1 className="font-display text-4xl font-semibold tracking-[0.02em] text-[var(--hero-ink)] sm:text-5xl">
            Steak Cook Time Estimator
          </h1>
          <p className="mt-2 max-w-2xl text-base text-[var(--hero-sub)] sm:text-lg">
            Choose your cut, doneness, and oven setup to get a practical time range.
          </p>
        </header>

        <div className="grid gap-4 lg:grid-cols-[1.04fr,0.96fr] lg:items-stretch lg:gap-4">
          <InputCard
            cuts={data.cuts}
            donenessTargets={data.doneness_targets}
            ovenModes={REVERSE_SEAR_OVEN_MODES}
            ovenTemps={COMMON_OVEN_TEMPS}
            defaultWeightOz={defaultWeightOz}
            values={values}
            onChange={handleChange}
          />
          <ResultCard
            title="Cooking Card"
            subtitle="Reverse sear (oven first, sear after)"
            result={calibratedResult}
            ovenTempF={values.ovenTempF}
            ovenMode={values.ovenMode}
          />
        </div>
      </div>
    </main>
  );
}
