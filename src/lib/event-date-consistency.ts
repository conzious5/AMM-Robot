import { formatInTimeZone } from "date-fns-tz";

const monthNumbers: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export type EventTitleDate = { month: number; day: number; year: number };

export function eventTitleDate(name: string): EventTitleDate | null {
  const match = name.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
  );
  if (!match) return null;
  return {
    month: monthNumbers[match[1]!.toLowerCase()]!,
    day: Number(match[2]),
    year: Number(match[3]),
  };
}

export function eventTitleDateMismatch(name: string, startsAt: Date, timezone: string) {
  const titleDate = eventTitleDate(name);
  if (!titleDate) return false;
  return titleDate.year !== Number(formatInTimeZone(startsAt, timezone, "yyyy"))
    || titleDate.month !== Number(formatInTimeZone(startsAt, timezone, "M"))
    || titleDate.day !== Number(formatInTimeZone(startsAt, timezone, "d"));
}

export function eventWasMissingFromSuccessfulVscoScan(input: {
  vscoEventId: string | null;
  startsAt: Date;
  canceled: boolean;
}, seenExternalIds: ReadonlySet<string>, from: Date, to: Date) {
  return Boolean(
    input.vscoEventId
    && !input.canceled
    && input.startsAt >= from
    && input.startsAt <= to
    && !seenExternalIds.has(input.vscoEventId),
  );
}
