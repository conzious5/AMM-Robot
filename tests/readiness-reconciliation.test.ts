import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFind: vi.fn(),
  eventList: vi.fn(),
  rules: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  event: { findUniqueOrThrow: mocks.eventFind, findMany: mocks.eventList },
  requiredRoleRule: { findMany: mocks.rules },
  operationalAlert: { updateMany: mocks.retire },
} }));
vi.mock("@/services/project-manager", () => ({
  notifyProjectManagers: vi.fn(), sendReadyNotification: vi.fn(),
}));
import { calculateEventReadiness, reconcileAllEventReadiness } from "@/services/readiness";

describe("readiness alert recovery", () => {
  beforeEach(() => vi.resetAllMocks());

  it("excludes all calculated alerts from readiness inputs while retaining provider blockers", async () => {
    const alerts = [
      { deduplicationKey: "readiness:e1:old-risk", reason: "Event is within 7 days and is not ready" },
      { deduplicationKey: "readiness:e1:old-change", reason: "Important event details changed after confirmation" },
      { deduplicationKey: "vsco-date-mismatch:e1", reason: "VSCO date conflict" },
    ];
    mocks.eventFind.mockImplementation(async ({ include }) => {
      const excludedPrefix = include.operationalAlerts.where.NOT.deduplicationKey.startsWith;
      return {
        canceled: false, startsAt: new Date("2026-10-11T22:00:00Z"),
        venueName: "The Manor", address: "1 Main St", eventType: "Wedding",
        assignments: [{ id: "a1", role: "VIDEOGRAPHER", active: true,
          confirmationStatus: "CONFIRMED", confirmedAt: new Date("2026-10-01T00:00:00Z"),
          person: { displayName: "Contractor", email: "test@example.com", emailEligible: true },
          plannedActions: [], messages: [],
        }],
        changeHistory: [], operationalTasks: [],
        operationalAlerts: alerts.filter(alert => !alert.deduplicationKey.startsWith(excludedPrefix)),
      };
    });
    mocks.rules.mockResolvedValue([]);
    const result = await calculateEventReadiness("e1", new Date("2026-10-05T12:00:00Z"));
    expect(result.reasons).toContain("VSCO date conflict");
    expect(result.reasons).not.toContain("Important event details changed after confirmation");
    alerts.pop();
    expect(await calculateEventReadiness("e1", new Date("2026-10-05T12:00:00Z")))
      .toEqual({ status: "READY", reasons: [] });
  });

  it("retires calculated alerts for past or canceled events without resolving independent alerts", async () => {
    mocks.eventList.mockResolvedValue([]);
    const now = new Date("2026-10-05T12:00:00Z");
    await reconcileAllEventReadiness(now);
    expect(mocks.retire).toHaveBeenCalledWith({
      where: {
        status: "OPEN", deduplicationKey: { startsWith: "readiness:" },
        event: { OR: [{ startsAt: { lt: now } }, { canceled: true }] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
  });
});
