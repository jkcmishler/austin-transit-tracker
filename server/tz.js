// Timezone helpers for America/Chicago (CapMetro's local time).
// DST means the UTC offset varies (-06:00 standard, -05:00 daylight) so any
// fixed-offset arithmetic drifts by 1 hour for half the year.

const TZ = "America/Chicago";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

// Given a UTC epoch (seconds), return the offset (in seconds) such that
// utc + offset = wall-clock seconds in Chicago for that instant.
// Standard time: offset = -6*3600. DST: offset = -5*3600.
export function chicagoOffsetSec(epochSec) {
  const ms = epochSec * 1000;
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t) => Number(parts.find(p => p.type === t).value);
  // Reinterpret the rendered local time as if it were UTC, then subtract the
  // original UTC; the delta is the offset.
  const localAsUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") === 24 ? 0 : get("hour"), // Intl rarely emits 24; defensive
    get("minute"), get("second")
  );
  return Math.round((localAsUtc - ms) / 1000);
}

// Return UTC epoch seconds for 00:00:00 America/Chicago on YYYYMMDD.
// Handles DST correctly: on spring-forward day (e.g. 2026-03-08), midnight
// Chicago is still in CST even though noon that day is already in CDT.
export function startOfChicagoDayFromYmd(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  // Probe at midnight UTC of the same date. That instant is always 18-19h of
  // the *previous* Chicago day, so it sits on the standard-time side of any
  // 2am DST transition occurring during this Chicago day — which is the offset
  // we need to compute midnight-Chicago itself.
  const probeUtcSec = Date.UTC(y, m - 1, d, 0, 0, 0) / 1000;
  const offsetSec = chicagoOffsetSec(probeUtcSec); // negative for Chicago
  return Date.UTC(y, m - 1, d, 0, 0, 0) / 1000 - offsetSec;
}

// Return YYYY-MM-DD string for the Chicago-local date of a UTC epoch (sec).
export function chicagoYmdFromEpochSec(epochSec) {
  const parts = fmt.formatToParts(new Date(epochSec * 1000));
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
