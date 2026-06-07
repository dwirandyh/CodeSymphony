const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const MONTH = DAY * 30;
const YEAR = DAY * 365;

/**
 * Formats an ISO timestamp into a short relative label like "24d ago".
 * Falls back to "just now" for very recent timestamps. Days run all the way
 * up to a month (so "24d ago" rather than "3w ago"), matching the design.
 */
export function formatRelativeTime(
  isoTimestamp: string,
  now: number = Date.now(),
): string {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  const deltaSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));

  if (deltaSeconds < MINUTE) {
    return "just now";
  }
  if (deltaSeconds < HOUR) {
    return `${Math.floor(deltaSeconds / MINUTE)}m ago`;
  }
  if (deltaSeconds < DAY) {
    return `${Math.floor(deltaSeconds / HOUR)}h ago`;
  }
  if (deltaSeconds < MONTH) {
    return `${Math.floor(deltaSeconds / DAY)}d ago`;
  }
  if (deltaSeconds < YEAR) {
    return `${Math.floor(deltaSeconds / MONTH)}mo ago`;
  }
  return `${Math.floor(deltaSeconds / YEAR)}y ago`;
}
