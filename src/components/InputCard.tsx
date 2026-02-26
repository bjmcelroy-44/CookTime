import type { ChangeEvent } from "react";
import type { EstimatorInputs, StartTempAssumption } from "../lib/timeModel";
import type { Cut, DonenessTarget } from "../types/steak";

interface InputCardProps {
  cuts: Cut[];
  donenessTargets: DonenessTarget[];
  ovenModes: string[];
  ovenTemps: number[];
  defaultWeightOz: number;
  values: EstimatorInputs;
  onChange: (changes: Partial<EstimatorInputs>) => void;
}

const WEIGHT_MIN_OZ = 4;
const WEIGHT_MAX_OZ = 64;
const WEIGHT_STEP_OZ = 0.5;
const DONENESS_ORDER = ["rare", "med_rare", "medium", "med_well", "well"];

const clampThickness = (value: number): number => {
  if (Number.isNaN(value)) {
    return 0.5;
  }
  return Math.min(2.5, Math.max(0.5, value));
};

const clampWeight = (value: number): number => {
  if (Number.isNaN(value)) {
    return WEIGHT_MIN_OZ;
  }
  return Math.min(WEIGHT_MAX_OZ, Math.max(WEIGHT_MIN_OZ, value));
};

const formatDoneness = (donenessId: string): string =>
  donenessId.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const sortDonenessTargets = (targets: DonenessTarget[]): DonenessTarget[] =>
  [...targets].sort((a, b) => {
    const orderA = DONENESS_ORDER.indexOf(a.doneness_id);
    const orderB = DONENESS_ORDER.indexOf(b.doneness_id);
    const hasOrderA = orderA >= 0;
    const hasOrderB = orderB >= 0;

    if (hasOrderA && hasOrderB) {
      return orderA - orderB;
    }

    if (hasOrderA) {
      return -1;
    }

    if (hasOrderB) {
      return 1;
    }

    const targetDiff = a.target_temp_f - b.target_temp_f;
    if (targetDiff !== 0) {
      return targetDiff;
    }

    return a.doneness_id.localeCompare(b.doneness_id);
  });

export default function InputCard({
  cuts,
  donenessTargets,
  ovenModes,
  ovenTemps,
  defaultWeightOz,
  values,
  onChange
}: InputCardProps) {
  const sortedDonenessTargets = sortDonenessTargets(donenessTargets);
  const selectedDonenessIndex = Math.max(
    0,
    sortedDonenessTargets.findIndex(
      (target) => target.doneness_id === values.donenessId
    )
  );
  const selectedDoneness =
    sortedDonenessTargets[selectedDonenessIndex] ?? sortedDonenessTargets[0];
  const sortedOvenTemps = [...ovenTemps].sort((a, b) => a - b);
  const selectedOvenTempIndex = sortedOvenTemps.reduce((bestIndex, temp, index) => {
    const bestDiff = Math.abs(sortedOvenTemps[bestIndex] - values.ovenTempF);
    const nextDiff = Math.abs(temp - values.ovenTempF);
    return nextDiff < bestDiff ? index : bestIndex;
  }, 0);
  const selectedOvenTempF =
    sortedOvenTemps[selectedOvenTempIndex] ?? values.ovenTempF;

  const handleDonenessRange = (event: ChangeEvent<HTMLInputElement>): void => {
    const index = Math.round(Number(event.target.value));
    const target = sortedDonenessTargets[index];
    if (!target) {
      return;
    }

    onChange({ donenessId: target.doneness_id });
  };

  const handleThicknessRange = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = clampThickness(Number(event.target.value));
    onChange({ thicknessIn: next });
  };

  const handleWeightRange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ weightOz: clampWeight(Number(event.target.value)) });
  };

  const handleOvenTempRange = (event: ChangeEvent<HTMLInputElement>): void => {
    const index = Math.round(Number(event.target.value));
    const nextTemp = sortedOvenTemps[index];
    if (typeof nextTemp !== "number") {
      return;
    }

    onChange({ ovenTempF: nextTemp });
  };

  const displayedWeightOz = clampWeight(
    values.weightOz ?? Number(defaultWeightOz.toFixed(1))
  );
  const usingCustomWeight =
    typeof values.weightOz === "number" && Number.isFinite(values.weightOz);

  return (
    <section className="card-panel h-full">
      <h2 className="font-display text-3xl font-bold uppercase tracking-[0.04em] text-[var(--ink)]">
        Inputs
      </h2>
      <div className="mt-3 space-y-3">
        <div>
          <p className="field-label">Steak cut</p>
          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {cuts.map((cut) => (
              <button
                key={cut.cut_id}
                type="button"
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                  values.cutId === cut.cut_id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]"
                    : "border-[var(--stroke)] bg-[var(--card-soft)] text-[var(--ink)] hover:border-[var(--accent)]"
                }`}
                onClick={() =>
                  onChange({
                    cutId: cut.cut_id,
                    thicknessIn: clampThickness(cut.typical_thickness_in),
                    weightOz: undefined
                  })
                }
              >
                <span className="block text-[15px] font-extrabold leading-tight">
                  {cut.display_name}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
          <label className="field-label mb-2" htmlFor="doneness-slider">
            Doneness: {formatDoneness(selectedDoneness.doneness_id)} (
            {selectedDoneness.target_temp_f}F target / {selectedDoneness.pull_temp_f}F pull)
          </label>
          <input
            id="doneness-slider"
            type="range"
            min={0}
            max={Math.max(0, sortedDonenessTargets.length - 1)}
            step={1}
            value={selectedDonenessIndex}
            onChange={handleDonenessRange}
            className="w-full"
          />
          <div
            className="mt-2 grid gap-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, sortedDonenessTargets.length)}, minmax(0, 1fr))`
            }}
          >
            {sortedDonenessTargets.map((target, index) => {
              const isActive = index === selectedDonenessIndex;
              return (
                <button
                  key={target.doneness_id}
                  type="button"
                  className={`rounded-md px-1 py-1 text-center transition ${
                    isActive
                      ? "bg-[var(--accent-soft)] text-[var(--ink)]"
                      : "bg-transparent text-[var(--muted)]"
                  }`}
                  onClick={() => onChange({ donenessId: target.doneness_id })}
                >
                  <span className="block leading-tight">{formatDoneness(target.doneness_id)}</span>
                  <span className="block leading-tight">{target.target_temp_f}F</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
            <label className="field-label mb-2" htmlFor="thickness-range">
              Thickness: {values.thicknessIn.toFixed(2)} in
            </label>
            <input
              id="thickness-range"
              type="range"
              min={0.5}
              max={2.5}
              step={0.25}
              value={values.thicknessIn}
              onChange={handleThicknessRange}
              className="w-full"
            />
          </div>

          <div className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
            <label className="field-label mb-2" htmlFor="steak-weight-slider">
              Steak weight: {displayedWeightOz.toFixed(1)} oz
            </label>
            <input
              id="steak-weight-slider"
              type="range"
              min={WEIGHT_MIN_OZ}
              max={WEIGHT_MAX_OZ}
              step={WEIGHT_STEP_OZ}
              value={displayedWeightOz}
              onChange={handleWeightRange}
              className="w-full"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
              <span>Default: {defaultWeightOz.toFixed(1)} oz</span>
              {usingCustomWeight ? (
                <button
                  type="button"
                  className="rounded-lg border border-[var(--stroke)] bg-white/80 px-2 py-1 text-[10px] font-bold text-[var(--ink)] hover:border-[var(--accent)]"
                  onClick={() => onChange({ weightOz: undefined })}
                >
                  Reset To Default
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
          <label className="field-label mb-2" htmlFor="oven-temp-slider">
            Oven temp: {selectedOvenTempF}F
          </label>
          <input
            id="oven-temp-slider"
            type="range"
            min={0}
            max={Math.max(0, sortedOvenTemps.length - 1)}
            step={1}
            value={selectedOvenTempIndex}
            onChange={handleOvenTempRange}
            className="w-full"
          />
          <div
            className="mt-2 grid gap-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, sortedOvenTemps.length)}, minmax(0, 1fr))`
            }}
          >
            {sortedOvenTemps.map((temp, index) => {
              const isActive = index === selectedOvenTempIndex;
              const showMajorLabel = temp % 50 === 0;
              return (
                <div
                  key={temp}
                  className={`rounded-md px-1 py-1 text-center transition ${
                    isActive
                      ? "bg-[var(--accent-soft)] text-[var(--ink)]"
                      : "bg-transparent text-[var(--muted)]"
                  }`}
                >
                  {showMajorLabel ? temp : ""}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="field-label">Cooking method</p>
            <p className="flex min-h-[42px] items-center px-1 text-sm font-semibold leading-snug text-[var(--ink)]">
              Reverse sear (oven first, sear after)
            </p>
          </div>

          <div>
            <label className="field-label" htmlFor="oven-mode">
              Oven mode
            </label>
            <select
              id="oven-mode"
              className="field-control"
              value={values.ovenMode}
              onChange={(event) => onChange({ ovenMode: event.target.value })}
            >
              {ovenModes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset>
          <legend className="field-label">Starting temp</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              { value: "fridge", label: "From fridge" },
              { value: "tempered", label: "Tempered" }
            ].map((option) => {
              const active = values.startTempAssumption === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]"
                      : "border-[var(--stroke)] bg-white/80 text-[var(--muted)] hover:border-[var(--accent)]"
                  }`}
                  onClick={() =>
                    onChange({ startTempAssumption: option.value as StartTempAssumption })
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
