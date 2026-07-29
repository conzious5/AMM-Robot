import { fromZonedTime, toZonedTime } from "date-fns-tz";

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
