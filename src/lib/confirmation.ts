import { Channel, ConfirmationStatus } from "@prisma/client";
import { db } from "./db";
import { createOpaqueToken, sha256 } from "./crypto";

export async function issueConfirmationToken(assignmentId: string, days = 45) {
  const { token, hash } = createOpaqueToken();
  await db.confirmationToken.create({ data: { tokenHash: hash, assignmentId, expiresAt: new Date(Date.now() + days * 86400000) } });
  return token;
}
export async function getConfirmation(token: string) {
  return db.confirmationToken.findUnique({ where: { tokenHash: sha256(token) }, include: { assignment: { include: { person: true, event: true } } } });
}
export async function confirmWithToken(token: string) {
  return db.$transaction(async tx => {
    const record = await tx.confirmationToken.findUnique({ where: { tokenHash: sha256(token) }, include: { assignment: true } });
    if (!record || record.usedAt || record.revokedAt || record.expiresAt <= new Date()) throw new Error("This confirmation link is invalid or expired.");
    if (!record.assignment.active || record.assignment.confirmationStatus === ConfirmationStatus.CANCELED) throw new Error("This assignment is no longer active.");
    const now = new Date();
    await tx.confirmationToken.update({ where: { id: record.id }, data: { usedAt: now } });
    const assignment = await tx.assignment.update({ where: { id: record.assignmentId }, data: { confirmationStatus: "CONFIRMED", confirmedAt: now, confirmationChannel: Channel.SYSTEM, needsAttention: false } });
    await tx.plannedAction.updateMany({ where: { assignmentId: assignment.id, status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] } }, data: { status: "CANCELED", canceledAt: now } });
    await tx.auditLog.create({ data: { actorType: "CONTRACTOR", action: "ASSIGNMENT_CONFIRMED", entityType: "Assignment", entityId: assignment.id, after: { channel: "LINK", confirmedAt: now.toISOString() } } });
    return assignment;
  });
}
