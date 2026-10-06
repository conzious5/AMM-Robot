import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ admin: vi.fn(), claim: vi.fn(), person: vi.fn(), update: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { administrator: { findUniqueOrThrow: m.admin }, setting: { create: m.claim }, person: { findUniqueOrThrow: m.person, update: m.update }, auditLog: { create: m.audit } } }));
vi.mock("@/lib/queue", () => ({ actionsQueue: {} }));
import { updatePersonContact } from "@/services/operations";
describe("editing stopped contractor contacts", () => {
  beforeEach(() => { vi.resetAllMocks(); m.admin.mockResolvedValue({ role: "ADMIN" }); });
  it("keeps SMS stopped when the administrator updates an existing contact", async () => {
    m.person.mockResolvedValue({ email: "old@example.com", phone: "+13035550100", smsEligible: false });
    await updatePersonContact("admin", "person", { email: "new@example.com", phone: "+13035550100" }, "edit1");
    expect(m.update.mock.calls[0][0].data).toMatchObject({ email: "new@example.com", smsEligible: false });
  });
  it("allows a previously missing phone number to become available", async () => {
    m.person.mockResolvedValue({ email: "old@example.com", phone: null, smsEligible: false });
    await updatePersonContact("admin", "person", { email: "old@example.com", phone: "+13035550100" }, "edit2");
    expect(m.update.mock.calls[0][0].data.smsEligible).toBe(true);
  });
});
