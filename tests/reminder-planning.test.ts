import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ assignment: vi.fn(), update: vi.fn(), policies: vi.fn(), actions: vi.fn(), cancel: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  assignment: { findUniqueOrThrow: m.assignment, update: m.update },
  reminderPolicy: { findMany: m.policies },
  plannedAction: { findMany: m.actions, updateMany: m.cancel, upsert: m.upsert },
} }));
import { planAssignmentReminders } from "@/lib/reminders";
describe("reminder replanning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.assignment.mockResolvedValue({ id: "a", eventId: "e", personId: "p", active: true, paused: false, confirmationStatus: "PENDING", role: "VIDEOGRAPHER",
      event: { canceled: false, paused: false, startsAt: new Date("2026-10-11T22:00:00Z"), timezone: "America/Denver", name: "Wedding", venueName: "Venue", address: "Address" },
      person: { active: true, paused: false, timezone: "America/Denver", firstName: "Chris" } });
    m.policies.mockResolvedValue([{ id: "policy", name: "Four weeks", offsetMinutes: 40320, honorQuietHours: true, channel: "EMAIL", messageTemplate: "Hello {{firstName}}", subjectTemplate: null }]);
    m.actions.mockResolvedValueOnce([{ idempotencyKey: "reminder:a:policy", status: "SUPPRESSED", lastError: "Communications paused" }]).mockResolvedValue([]);
    m.upsert.mockResolvedValue({ id: "action" });
  });
  it("revives a suppressed step and schedules catch-up without advancing past it", async () => {
    await planAssignmentReminders("a", new Date("2026-10-06T03:00:00Z"));
    const update = m.upsert.mock.calls[0][0].update;
    expect(update).toMatchObject({ status: "PLANNED", canceledAt: null, jobQueueId: null, lastError: null });
    expect(update.scheduledFor).toEqual(new Date("2026-10-06T14:00:00Z"));
  });
  it.each(["CONFIRMED", "DECLINED", "CANCELED"])("does not schedule for %s assignments", async confirmationStatus => {
    const assignment = await m.assignment();
    m.assignment.mockResolvedValue({ ...assignment, confirmationStatus });
    await planAssignmentReminders("a");
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { nextReminderAt: null } });
  });
});
