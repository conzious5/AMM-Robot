import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ person: vi.fn(), previous: vi.fn(), alert: vi.fn(), resolve: vi.fn(), assignments: vi.fn(), plan: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  person: { findUniqueOrThrow: m.person }, operationalAlert: { findUnique: m.previous, upsert: m.alert, updateMany: m.resolve }, assignment: { findMany: m.assignments },
} }));
vi.mock("@/lib/reminders", () => ({ planAssignmentReminders: m.plan }));
vi.mock("@/services/project-manager", () => ({ notifyProjectManagers: m.notify }));
import { reconcileContractorSmsOptOut } from "@/services/contractor-contact";
import { deterministicIntent, inboundAutomationText } from "@/services/inbound";
import { humanConversationOwnsReply } from "@/services/quo-context";
describe("contractor communication accountability", () => {
  it.each(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"])("recognizes provider opt-out keyword %s", text => {
    expect(deterministicIntent(inboundAutomationText(text)!)).toBe("STOP");
    expect(humanConversationOwnsReply({ automationText: inboundAutomationText(text), explicitlyInvokedRobot: false, lastOutboundWasHuman: true })).toBe(false);
  });
  beforeEach(() => { vi.resetAllMocks(); m.person.mockResolvedValue({ displayName: "Chris", smsEligible: false }); m.alert.mockResolvedValue({ firstSeenAt: new Date("2026-10-06T03:00:00Z") }); m.assignments.mockResolvedValue([{ id: "a" }]); });
  it("raises a critical issue and notifies the owner and project manager without changing bookings", async () => {
    await reconcileContractorSmsOptOut("p", true);
    expect(m.alert.mock.calls[0][0].create).toMatchObject({ type: "CONTRACTOR_SMS_OPT_OUT", severity: "CRITICAL", personId: "p" });
    expect(m.plan).toHaveBeenCalledWith("a");
    expect(m.notify.mock.calls[0][0]).toMatchObject({ includeAdministrators: true, type: "CONTRACTOR_SMS_OPT_OUT" });
  });
  it("surfaces historic opt-outs without sending repeated notifications on each scan", async () => {
    await reconcileContractorSmsOptOut("p");
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(m.notify).not.toHaveBeenCalled();
  });
  it("resolves the communication issue when the contractor resumes texts", async () => {
    m.person.mockResolvedValue({ smsEligible: true });
    await reconcileContractorSmsOptOut("p");
    expect(m.resolve).toHaveBeenCalledTimes(1);
    expect(m.alert).not.toHaveBeenCalled();
  });
  it("starts a new notification episode if they stop again after resuming", async () => {
    m.previous.mockResolvedValue({ status: "RESOLVED" });
    await reconcileContractorSmsOptOut("p", true);
    expect(m.alert.mock.calls[0][0].update.firstSeenAt).toBeInstanceOf(Date);
  });
});
