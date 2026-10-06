import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ env: () => ({
  VSCO_API_KEY: "test-key", VSCO_EVENTS_PATH: "/event",
  VSCO_API_BASE_URL: "https://example.test/api/v2/", DEFAULT_TIMEZONE: "America/Denver",
}) }));
import { VscoWorkspaceProvider, vscoCalendarDateIsInWindow } from "@/providers/vsco";

afterEach(() => vi.unstubAllGlobals());
describe("VSCO local calendar window", () => {
  it("does not import a historical TBD ceremony with a current UTC timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{ id: "672476152", jobId: "19344796", name: "Wedding Ceremony",
        startDate: "2025-06-05", startTime: null,
        startUtc: "2026-10-06T03:15:27Z", timezoneName: "America/Denver",
      }], meta: { totalPages: 1 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pages = [];
    for await (const page of new VscoWorkspaceProvider().events({
      from: new Date("2026-08-01T00:00:00Z"), to: new Date("2027-10-01T00:00:00Z"),
    })) pages.push(page);
    expect(pages).toEqual([{ events: [], cursor: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses local calendar boundaries and supports responses without a local date", () => {
    const from = new Date("2026-10-06T03:00:00Z");
    const to = new Date("2026-10-07T03:00:00Z");
    expect(vscoCalendarDateIsInWindow("2026-10-05", "America/Denver", from, to)).toBe(true);
    expect(vscoCalendarDateIsInWindow("2026-10-07", "America/Denver", from, to)).toBe(false);
    expect(vscoCalendarDateIsInWindow(null, "America/Denver", from, to)).toBe(true);
  });
});
