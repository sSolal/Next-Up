/* Durations: what `estimate` and `spent` hold. Pure. */

/**
 * `45m`, `1h30`, `1h 30m`, `2h`, `1.5h`, `90min`, `½d`… → minutes. A bare number is hours (the older schema
 * wrote `estimate: 5` for five hours). A day is 8h, a week 40h. Text after the duration is ignored
 * (`240h (success if 30% done)`), so are `~` and `≈`.
 */
export function parseDuration(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return isFinite(v) && v >= 0 ? Math.round(v * 60) : undefined;
  const s = String(v).trim().toLowerCase().replace(/^[~≈]\s*/, "").replace(",", ".");
  // 1h30, 1h 30, 1h30m, 1 h 30 min
  const hm = s.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?|eures?)?\s*(\d+)\s*(?:m|min|minutes?)?\b/);
  if (hm) return Math.round(parseFloat(hm[1]) * 60 + parseInt(hm[2]));
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(min|minutes?|m|h|hours?|heures?|d|days?|j|jours?|w|weeks?|semaines?)?\b/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? "h";
  if (unit.startsWith("m")) return Math.round(n);
  if (unit.startsWith("d") || unit.startsWith("j")) return Math.round(n * 8 * 60);
  if (unit.startsWith("w") || unit.startsWith("s")) return Math.round(n * 40 * 60);
  return Math.round(n * 60);
}

/** 45 → `45m`, 60 → `1h`, 200 → `3h20`, 0 → `0m`. */
export function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
}

/** Quick picks offered wherever an estimate is asked for. */
export const ESTIMATE_PRESETS = ["15m", "30m", "1h", "2h", "4h"];

/**
 * A duration typed at the end of a title, with its unit (`Write the post 1h30`, `Call Bob 15m`, `… ~2h`):
 * the title without it, and the minutes. A bare number is left in the title (`Send 5 mails`).
 */
export function splitEstimate(title: string): { title: string; estimate?: number } {
  const m = title.match(/^(.*\S)\s+[~≈]?(\d+(?:[.,]\d+)?\s*(?:h\s*\d+|h|min|m))$/i);
  if (!m) return { title };
  const estimate = parseDuration(m[2]);
  return estimate ? { title: m[1], estimate } : { title };
}
