import type { UiEstimateResult } from "../types/estimate";

interface ResultCardProps {
  title: string;
  subtitle?: string;
  result: UiEstimateResult;
  ovenTempF?: number;
  ovenMode?: string;
  className?: string;
}

export default function ResultCard({
  title,
  subtitle,
  result,
  ovenTempF,
  ovenMode,
  className
}: ResultCardProps) {
  const formatMinutes = (minutes: number): string =>
    `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

  const ovenModeLabel = ovenMode
    ? `${ovenMode.charAt(0).toUpperCase()}${ovenMode.slice(1)} mode`
    : "selected oven mode";

  return (
    <section className={`card-panel h-full ${className ?? ""}`}>
      <h2 className="font-display text-2xl font-semibold leading-none text-[var(--ink)] sm:text-3xl">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-1 text-sm font-medium text-[var(--muted)]">{subtitle}</p>
      ) : null}

      {result.status === "error" ? (
        <div className="mt-5 rounded-2xl border border-amber-300/60 bg-amber-50/80 p-4">
          <p className="text-base font-semibold text-amber-900">No estimate found</p>
          <p className="mt-1 text-sm text-amber-800">{result.message}</p>
          <p className="mt-3 text-sm text-amber-800/90">
            Try a different temperature, method, or thickness.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm font-semibold text-[var(--muted)]">
              Estimated cook time in the oven is:
            </p>
            <p className="mt-1 text-3xl font-extrabold leading-none text-[var(--ink)] sm:text-4xl">
              {formatMinutes(result.timeRangeMinutes.low)}
            </p>
          </div>

          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">
              Step-by-step
            </p>
            <ol className="mt-2 space-y-2">
              <li className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                  Step 1
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--ink)]">
                  {ovenTempF
                    ? `Preheat oven to ${ovenTempF}F in ${ovenModeLabel}. Set steak on a wire cooling rack over a sheet pan so it sits above the hot surface and cooks more evenly.`
                    : "Preheat oven using your selected temperature and mode."}
                </p>
              </li>
              <li className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                  Step 2
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--ink)]">
                  Cook in the oven for about {formatMinutes(result.timeRangeMinutes.low)}.
                  This uses the low-end estimate, so start temping the steak right at
                  that time.
                </p>
              </li>
              <li className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                  Step 3
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--ink)]">
                  Pull at 125F and rest for 5 minutes. While it rests, heat a skillet
                  on high (use good ventilation, as it can get smoky), add tallow or a
                  high smoke-point oil, then sear 90 seconds per side.
                </p>
              </li>
              <li className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                  Step 4
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--ink)]">
                  Slice against the grain and serve.
                </p>
              </li>
            </ol>
          </div>

          <p className="rounded-xl border border-[var(--stroke)] bg-[var(--card-soft)] p-3 text-[14px] leading-relaxed text-[var(--ink)]">
            <span className="font-semibold">Quick summary:</span> Roast on a wire
            rack for the estimated oven time, pull at 125F, rest 5 minutes, then
            sear 90 seconds per side in a very hot skillet with tallow or high
            smoke-point oil.
          </p>
        </div>
      )}

      <p className="mt-4 text-xs text-[var(--muted)] sm:text-sm">
        Even if you set your oven to 250F, actual internal oven temperature can vary by
        oven. Keeping a thermometer handy to double-check is always helpful.
      </p>
    </section>
  );
}
