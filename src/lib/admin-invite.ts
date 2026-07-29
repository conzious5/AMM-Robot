import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";

export type AdministratorInviteValue = {
  administratorId: string;
  createdAt: string;
  expiresAt: string;
};

export function administratorInviteKey(token: string) {
  return `administrator-invite:${createHash("sha256").update(token).digest("hex")}`;
}

export function administratorInviteIsUsable(value: unknown, now = new Date()): value is AdministratorInviteValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AdministratorInviteValue>;
  return Boolean(
    candidate.administratorId &&
    candidate.createdAt &&
    candidate.expiresAt &&
    Number.isFinite(new Date(candidate.expiresAt).getTime()) &&
    new Date(candidate.expiresAt) > now,
  );
}

export async function createAdministratorInvite(administratorId: string, now = new Date(), ttlHours = 48) {
  const administrator = await db.administrator.findUniqueOrThrow({ where: { id: administratorId } });
  if (!administrator.active) throw new Error("An inactive administrator cannot be invited.");
  const token = randomBytes(32).toString("base64url");
  const value: AdministratorInviteValue = {
    administratorId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
  };
  await db.setting.create({ data: { key: administratorInviteKey(token), value } });
  await db.auditLog.create({
    data: {
      actorType: "SYSTEM",
      action: "ADMINISTRATOR_INVITE_CREATED",
      entityType: "Administrator",
      entityId: administratorId,
      after: { expiresAt: value.expiresAt },
    },
  });
  return { token, expiresAt: new Date(value.expiresAt), administrator };
}

export async function getAdministratorInvite(token: string, now = new Date()) {
  if (!token) return null;
  const setting = await db.setting.findUnique({ where: { key: administratorInviteKey(token) } });
  if (!administratorInviteIsUsable(setting?.value, now)) return null;
  const administrator = await db.administrator.findUnique({ where: { id: setting.value.administratorId } });
  if (!administrator?.active) return null;
  return { administrator, expiresAt: new Date(setting.value.expiresAt) };
}

export async function completeAdministratorInvite(token: string, password: string, now = new Date()) {
  if (password.length < 12) throw new Error("Use a password with at least 12 characters.");
  const key = administratorInviteKey(token);
  return db.$transaction(async tx => {
    const setting = await tx.setting.findUnique({ where: { key } });
    if (!administratorInviteIsUsable(setting?.value, now)) throw new Error("This setup link is invalid or has expired.");
    const administrator = await tx.administrator.findUniqueOrThrow({ where: { id: setting.value.administratorId } });
    if (!administrator.active) throw new Error("This account is inactive.");
    await tx.administrator.update({
      where: { id: administrator.id },
      data: { passwordHash: await bcrypt.hash(password, 12) },
    });
    await tx.setting.delete({ where: { key } });
    await tx.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: administrator.id,
        action: "ADMINISTRATOR_INVITE_COMPLETED",
        entityType: "Administrator",
        entityId: administrator.id,
      },
    });
    return administrator;
  });
}
