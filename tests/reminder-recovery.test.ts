import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ setting: vi.fn(), marker: vi.fn(), events: vi.fn(), eventUpdate: vi.fn(), assignmentUpdate: vi.fn(), audit: vi.fn(), plan: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  setting: { findUnique: m.setting, upsert: m.marker },
  event: { findMany: m.events, update: m.eventUpdate },
  assignment: { update: m.assignmentUpdate }, auditLog: { create: m.audit },
} }));
vi.mock("@/lib/reminders", () => ({ planAssignmentReminders: m.plan }));
import { recoverBookedWeddingReminders } from "@/services/reminder-recovery";

describe("booked wedding recovery", () => {
  beforeEach(() => { vi.resetAllMocks(); m.setting.mockResolvedValue(null); });
  it("repairs returned upcoming weddings and replans pending assignments without bypassing opt-outs or confirmations", async () => {
    const pending = { id: "a", paused: true, confirmationStatus: "PENDING", person: { active: true, paused: false } };
    m.events.mockResolvedValue([{ id: "e", name: "Wedding", paused: true, startsAt: new Date("2026-10-11T22:00:00Z"), timezone: "America/Denver", assignments: [pending,
      { ...pending, id: "confirmed", confirmationStatus: "CONFIRMED" },
      { ...pending, id: "declined", confirmationStatus: "DECLINED" },
      { ...pending, id: "optout", person: { active: true, paused: true } },
    ] }]);
    const now = new Date("2026-10-06T03:00:00Z");
    await recoverBookedWeddingReminders(new Set(["vsco1"]), now);
    expect(m.events.mock.calls[0][0].where).toEqual({ vscoEventId: { in: ["vsco1"] }, canceled: false, startsAt: { gt: now } });
    expect(m.eventUpdate).toHaveBeenCalledWith({ where: { id: "e" }, data: { paused: false } });
    expect(m.assignmentUpdate).toHaveBeenCalledTimes(1);
    expect(m.plan).toHaveBeenCalledExactlyOnceWith("a", now);
    expect(m.audit).toHaveBeenCalledTimes(2);
    expect(m.marker).toHaveBeenCalledTimes(1);
  });
  it("runs once so subsequent intentional pauses remain intact", async () => {
    m.setting.mockResolvedValue({ value: { completedAt: "2026-10-06" } });
    await recoverBookedWeddingReminders(new Set(["vsco1"]));
    expect(m.events).not.toHaveBeenCalled();
  });
  it("does not mark an interrupted repair complete", async () => {
    m.events.mockRejectedValue(new Error("database unavailable"));
    await expect(recoverBookedWeddingReminders(new Set(["vsco1"]))).rejects.toThrow("database unavailable");
    expect(m.marker).not.toHaveBeenCalled();
  });
});
