import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { formatInTimeZone } from "date-fns-tz";

export function outsideQuietHours(date: Date, timezone: string, startHour = 21, endHour = 8) {
  const hour = toZonedTime(date, timezone).getHours();
  return startHour > endHour ? hour < startHour && hour >= endHour : hour < startHour || hour >= endHour;
}
export function nextAllowedTime(date: Date, timezone: string, startHour = 21, endHour = 8) {
  if (outsideQuietHours(date, timezone, startHour, endHour)) return date;
  const local = toZonedTime(date, timezone);
  local.setDate(local.getDate() + (local.getHours() >= startHour ? 1 : 0));
  local.setHours(endHour, 0, 0, 0);
  return fromZonedTime(local, timezone);
}

export function localDateKey(date: Date, timezone: string) {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd");
}

export function localDayBounds(date: Date, timezone: string) {
  const localStart = toZonedTime(date, timezone);
  localStart.setHours(0, 0, 0, 0);
  const localEnd = new Date(localStart);
  localEnd.setDate(localEnd.getDate() + 1);
  return {
    start: fromZonedTime(localStart, timezone),
    end: fromZonedTime(localEnd, timezone),
  };
}

export function nextUnoccupiedLocalDay(desired: Date, timezone: string, occupiedDateKeys: ReadonlySet<string>) {
  let candidate = nextAllowedTime(desired, timezone);
  for (let day = 0; day < 370; day += 1) {
    if (!occupiedDateKeys.has(localDateKey(candidate, timezone))) return candidate;
    const local = toZonedTime(candidate, timezone);
    local.setDate(local.getDate() + 1);
    candidate = nextAllowedTime(fromZonedTime(local, timezone), timezone);
  }
  throw new Error("Could not find an available daily reminder slot.");
}
