import { Channel, ConfirmationStatus } from "@prisma/client";
import { db } from "./db";
import { createOpaqueToken, sha256 } from "./crypto";
import { reconcileEventReadiness } from "@/services/readiness";

export async function issueConfirmationToken(assignmentId: string, days = 45) {
  const { token, hash } = createOpaqueToken();
  await db.confirmationToken.create({ data: { tokenHash: hash, assignmentId, expiresAt: new Date(Date.now() + days * 86400000) } });
  return token;
}

export function confirmationTokenIsUsable<T extends { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }>(
  record: T | null,
  now = new Date(),
): record is T {
  return Boolean(record && !record.usedAt && !record.revokedAt && record.expiresAt > now);
}

export async function getConfirmation(token: string) {
  const record = await db.confirmationToken.findUnique({ where: { tokenHash: sha256(token) }, include: { assignment: { include: { person: true, event: true } } } });
  return confirmationTokenIsUsable(record) ? record : null;
}
export async function confirmWithToken(token: string) {
  const assignment = await db.$transaction(async tx => {
    const record = await tx.confirmationToken.findUnique({ where: { tokenHash: sha256(token) }, include: { assignment: true } });
    if (!confirmationTokenIsUsable(record)) throw new Error("This confirmation link is invalid or expired.");
    if (!record.assignment.active || record.assignment.confirmationStatus === ConfirmationStatus.CANCELED) throw new Error("This assignment is no longer active.");
    const now = new Date();
    const claimed = await tx.confirmationToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new Error("This confirmation link is invalid or expired.");
    const assignment = await tx.assignment.update({ where: { id: record.assignmentId }, data: { confirmationStatus: "CONFIRMED", confirmedAt: now, confirmationChannel: Channel.SYSTEM, needsAttention: false } });
    await tx.plannedAction.updateMany({ where: { assignmentId: assignment.id, status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] } }, data: { status: "CANCELED", canceledAt: now } });
    await tx.auditLog.create({ data: { actorType: "CONTRACTOR", action: "ASSIGNMENT_CONFIRMED", entityType: "Assignment", entityId: assignment.id, after: { channel: "LINK", confirmedAt: now.toISOString() } } });
    return assignment;
  });
  await reconcileEventReadiness(assignment.eventId);
  return assignment;
}
