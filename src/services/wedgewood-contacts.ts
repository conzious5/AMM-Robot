import { db } from "@/lib/db";
import { assertPermission } from "@/lib/permissions";

type ContactInput = {
  venueName: string;
  contactName?: string;
  teamOrRole?: string;
  email: string;
};

const clean = (value?: string) => value?.trim() || null;

async function authorize(adminId: string) {
  const admin = await db.administrator.findUniqueOrThrow({ where: { id: adminId } });
  assertPermission(admin, "contacts:edit");
}

async function claim(adminId: string, idempotencyKey: string) {
  try {
    await db.setting.create({ data: { key: `wedgewood-contact:${idempotencyKey}`, value: { adminId, claimedAt: new Date().toISOString() } } });
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return false;
    throw error;
  }
}

function validate(input: ContactInput) {
  const venueName = input.venueName.trim();
  const email = input.email.trim().toLowerCase();
  if (!venueName) throw new Error("Venue or team is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  return { venueName, email, contactName: clean(input.contactName), teamOrRole: clean(input.teamOrRole) };
}

export async function createWedgewoodContact(adminId: string, input: ContactInput, idempotencyKey: string) {
  await authorize(adminId);
  if (!await claim(adminId, idempotencyKey)) return null;
  const values = validate(input);
  const contact = await db.wedgewoodContact.create({ data: { ...values, source: "MANUAL", manuallyEdited: true } });
  await db.auditLog.create({ data: { actorType: "ADMIN", actorId: adminId, action: "WEDGEWOOD_CONTACT_CREATED", entityType: "WedgewoodContact", entityId: contact.id, after: values, metadata: { idempotencyKey } } });
  return contact;
}

export async function updateWedgewoodContact(adminId: string, contactId: string, input: ContactInput, idempotencyKey: string) {
  await authorize(adminId);
  if (!await claim(adminId, idempotencyKey)) return db.wedgewoodContact.findUnique({ where: { id: contactId } });
  const values = validate(input);
  const before = await db.wedgewoodContact.findUniqueOrThrow({ where: { id: contactId } });
  const contact = await db.wedgewoodContact.update({ where: { id: contactId }, data: { ...values, active: true, manuallyEdited: true } });
  await db.auditLog.create({ data: { actorType: "ADMIN", actorId: adminId, action: "WEDGEWOOD_CONTACT_UPDATED", entityType: "WedgewoodContact", entityId: contact.id, before: { venueName: before.venueName, contactName: before.contactName, teamOrRole: before.teamOrRole, email: before.email }, after: values, metadata: { idempotencyKey } } });
  return contact;
}

export async function removeWedgewoodContact(adminId: string, contactId: string, idempotencyKey: string) {
  await authorize(adminId);
  if (!await claim(adminId, idempotencyKey)) return db.wedgewoodContact.findUnique({ where: { id: contactId } });
  const before = await db.wedgewoodContact.findUniqueOrThrow({ where: { id: contactId } });
  const contact = await db.wedgewoodContact.update({ where: { id: contactId }, data: { active: false, manuallyEdited: true } });
  await db.auditLog.create({ data: { actorType: "ADMIN", actorId: adminId, action: "WEDGEWOOD_CONTACT_REMOVED", entityType: "WedgewoodContact", entityId: contact.id, before: { active: before.active }, after: { active: false }, metadata: { idempotencyKey } } });
  return contact;
}
