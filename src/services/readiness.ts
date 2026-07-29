import { createHash } from "node:crypto";
import type { AssignmentRole, EventReadinessStatus } from "@prisma/client";
import { differenceInCalendarDays } from "date-fns";
import { db } from "@/lib/db";
import { notifyProjectManagers, sendReadyNotification } from "@/services/project-manager";

export type ReadinessInput = {
  canceled: boolean;
  venueName?: string | null;
  address?: string | null;
  daysUntilEvent: number;
  requiredRoles: { role: AssignmentRole; requiredCount: number }[];
  assignments: {
    id: string;
    role: AssignmentRole;
    confirmationStatus: string;
    personName: string;
    hasEmail: boolean;
    hasPhone: boolean;
    bothChannelsFailed?: boolean;
  }[];
  materialChangeAfterConfirmation: boolean;
  criticalOverdueTasks: string[];
  externalBlockingReasons: string[];
  completedReminderCount: number;
};

export function evaluateReadiness(input: ReadinessInput): { status: EventReadinessStatus; reasons: string[] } {
  if (input.canceled) return { status: "CANCELLED", reasons: ["Event is cancelled"] };
  const reasons: string[] = [];
  if (!input.venueName) reasons.push("Venue name is missing");
  if (!input.address) reasons.push("Venue address is missing");

  for (const requirement of input.requiredRoles) {
    const filled = input.assignments.filter(item => item.role === requirement.role).length;
    if (filled < requirement.requiredCount) {
      const label = requirement.role.toLowerCase().replaceAll("_", " ");
      reasons.push(`${requirement.requiredCount - filled} required ${label} role${requirement.requiredCount - filled === 1 ? " is" : "s are"} unfilled`);
    }
  }
  if (!input.assignments.length && !input.requiredRoles.length) reasons.push("No photographer or videographer is assigned");
  for (const assignment of input.assignments) {
    if (assignment.confirmationStatus === "DECLINED") reasons.push(`${assignment.personName} declined the ${assignment.role.toLowerCase()} assignment`);
    else if (assignment.confirmationStatus === "UNREACHABLE") reasons.push(`${assignment.personName} is unreachable`);
    else if (assignment.confirmationStatus !== "CONFIRMED") reasons.push(`${assignment.personName} has not confirmed`);
    if (!assignment.hasEmail && !assignment.hasPhone) reasons.push(`${assignment.personName} has no valid email or phone number`);
    if (assignment.bothChannelsFailed) reasons.push(`Email and SMS both failed for ${assignment.personName}`);
  }
  if (input.completedReminderCount >= 3 && input.assignments.some(item => item.confirmationStatus !== "CONFIRMED")) {
    reasons.push("An assignment remains unconfirmed after the escalation threshold");
  }
  reasons.push(...input.criticalOverdueTasks.map(name => `Critical preparation task is overdue: ${name}`));
  reasons.push(...input.externalBlockingReasons);

  if (input.materialChangeAfterConfirmation) {
    reasons.push("Important event details changed after confirmation");
    return { status: "CHANGED_SINCE_CONFIRMATION", reasons: [...new Set(reasons)] };
  }
  const unique = [...new Set(reasons)];
  if (!unique.length) return { status: "READY", reasons: [] };
  if (input.daysUntilEvent <= 7) {
    unique.push(`Event is within ${input.daysUntilEvent <= 3 ? "3" : "7"} days and is not ready`);
    return { status: "AT_RISK", reasons: [...new Set(unique)] };
  }
  if (unique.some(reason => /unfilled|missing|no photographer|no valid email|overdue/i.test(reason))) {
    return { status: "INCOMPLETE", reasons: unique };
  }
  if (unique.some(reason => /declined|unreachable|conflict|failed|escalation/i.test(reason))) {
    return { status: "AT_RISK", reasons: unique };
  }
  return { status: "WAITING_FOR_CONFIRMATION", reasons: unique };
}

export async function calculateEventReadiness(eventId: string, now = new Date()) {
  const event = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    include: {
      assignments: {
        where: { role: { in: ["PHOTOGRAPHER", "VIDEOGRAPHER", "ASSISTANT"] } },
        include: { person: true, plannedActions: true, messages: true },
      },
      changeHistory: true,
      operationalTasks: true,
      operationalAlerts: { where: { status: "OPEN", type: { not: "READINESS" } } },
    },
  });
  const activeAssignments = event.assignments.filter(assignment => assignment.active);
  const rules = await db.requiredRoleRule.findMany({ where: { jobType: event.eventType, active: true } });
  const confirmedTimes = event.assignments.map(item => item.confirmedAt).filter((value): value is Date => Boolean(value));
  const firstConfirmation = confirmedTimes.length ? new Date(Math.min(...confirmedTimes.map(value => value.getTime()))) : null;
  const materialChangeAfterConfirmation = Boolean(firstConfirmation && event.changeHistory.some(change =>
    ["startsAt", "endsAt", "venueName", "address", "assignment", "status"].includes(change.field) && change.createdAt > firstConfirmation
  ));
  const criticalOverdueTasks = event.operationalTasks
    .filter(task => task.criticalForReadiness && task.status === "OVERDUE")
    .map(task => task.name);
  const completedReminderCount = activeAssignments.reduce((count, assignment) =>
    count + assignment.plannedActions.filter(action => action.status === "COMPLETED" && ["REMINDER", "ESCALATE"].includes(action.type)).length, 0);
  return evaluateReadiness({
    canceled: event.canceled,
    venueName: event.venueName,
    address: event.address,
    daysUntilEvent: differenceInCalendarDays(event.startsAt, now),
    requiredRoles: rules.map(rule => ({ role: rule.role, requiredCount: rule.requiredCount })),
    assignments: activeAssignments.map(assignment => ({
      id: assignment.id,
      role: assignment.role,
      confirmationStatus: assignment.confirmationStatus,
      personName: assignment.person.displayName,
      hasEmail: Boolean(assignment.person.email && assignment.person.emailEligible),
      hasPhone: Boolean(assignment.person.phone && assignment.person.smsEligible),
      bothChannelsFailed: ["EMAIL", "SMS"].every(channel =>
        assignment.messages.some(message => message.channel === channel && ["FAILED", "BOUNCED"].includes(message.deliveryStatus))
      ),
    })),
    materialChangeAfterConfirmation,
    criticalOverdueTasks,
    externalBlockingReasons: event.operationalAlerts.map(alert => alert.reason),
    completedReminderCount,
  });
}

function reasonKey(reason: string) {
  return createHash("sha256").update(reason).digest("hex").slice(0, 16);
}

function alertDetails(reason: string) {
  if (/unfilled/i.test(reason)) return { type: "REQUIRED_ROLE_UNFILLED", severity: "HIGH", recommendedAction: "Assign the required photographer or videographer." };
  if (/declined/i.test(reason)) return { type: "ASSIGNMENT_DECLINED", severity: "CRITICAL", recommendedAction: "Contact a replacement contractor." };
  if (/unreachable|no valid email/i.test(reason)) return { type: "DELIVERY_FAILURE", severity: "HIGH", recommendedAction: "Correct the contractor contact information." };
  if (/changed after confirmation/i.test(reason)) return { type: "MATERIAL_CHANGE", severity: "CRITICAL", recommendedAction: "Review the change and reconfirm affected contractors." };
  if (/overdue/i.test(reason)) return { type: "CRITICAL_TASK_OVERDUE", severity: "HIGH", recommendedAction: "Complete or resolve the critical preparation task." };
  if (/within 3 days/i.test(reason)) return { type: "THREE_DAY_NOT_READY", severity: "CRITICAL", recommendedAction: "Resolve all readiness blockers immediately." };
  if (/within 7 days/i.test(reason)) return { type: "SEVEN_DAY_NOT_READY", severity: "HIGH", recommendedAction: "Review staffing and confirmation blockers today." };
  if (/escalation threshold/i.test(reason)) return { type: "UNCONFIRMED_ESCALATED", severity: "HIGH", recommendedAction: "Contact the contractor directly." };
  return { type: "READINESS", severity: "MEDIUM", recommendedAction: "Review this event in Operations." };
}

export async function reconcileEventReadiness(eventId: string, now = new Date()) {
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  if (event.internalNotes?.includes("[LAUNCH_CUTOFF_EXCLUDED]")) {
    await db.operationalAlert.updateMany({
      where: { eventId, status: "OPEN", deduplicationKey: { startsWith: `readiness:${eventId}:` } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    return {
      status: event.readinessStatus,
      reasons: Array.isArray(event.readinessReasons) ? event.readinessReasons.map(String) : [],
    };
  }
  const previous = event.readinessStatus;
  const result = await calculateEventReadiness(eventId, now);
  await db.event.update({
    where: { id: eventId },
    data: { readinessStatus: result.status, readinessReasons: result.reasons, readinessCalculatedAt: now },
  });

  const currentKeys = new Set<string>();
  for (const reason of result.reasons) {
    const key = `readiness:${eventId}:${reasonKey(reason)}`;
    currentKeys.add(key);
    const details = alertDetails(reason);
    const existing = await db.operationalAlert.findUnique({ where: { deduplicationKey: key } });
    const alert = await db.operationalAlert.upsert({
      where: { deduplicationKey: key },
      update: { status: "OPEN", resolvedAt: null, lastSeenAt: now, reason, ...details },
      create: { eventId, deduplicationKey: key, reason, ...details },
    });
    if (!existing || existing.status === "RESOLVED") {
      await notifyProjectManagers({
        eventId,
        type: details.type,
        subject: `${details.severity === "CRITICAL" ? "Urgent: " : ""}${event.name} needs attention`,
        body: `${event.name}: ${reason}\n\nRecommended action: ${details.recommendedAction}`,
        deduplicationKey: `alert:${alert.id}:${alert.firstSeenAt.toISOString()}`,
      });
    }
  }
  const openReadinessAlerts = await db.operationalAlert.findMany({ where: { eventId, status: "OPEN", deduplicationKey: { startsWith: `readiness:${eventId}:` } } });
  for (const alert of openReadinessAlerts) {
    if (!currentKeys.has(alert.deduplicationKey)) {
      await db.operationalAlert.update({ where: { id: alert.id }, data: { status: "RESOLVED", resolvedAt: now } });
    }
  }

  if (previous !== result.status) {
    await db.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "EVENT_READINESS_CHANGED",
        entityType: "Event",
        entityId: eventId,
        before: { status: previous },
        after: { status: result.status, reasons: result.reasons },
      },
    });
    const transitionKey = now.toISOString();
    if (result.status === "READY") await sendReadyNotification(eventId, transitionKey);
    else if (previous === "READY") {
      await notifyProjectManagers({
        eventId,
        type: "EVENT_NO_LONGER_READY",
        subject: `Action required: ${event.name} is no longer ready`,
        body: `${event.name} changed from ready to ${result.status.replaceAll("_", " ").toLowerCase()}.\n\n${result.reasons.join("\n")}`,
        deduplicationKey: `not-ready:${eventId}:${transitionKey}`,
      });
    }
  }
  return result;
}

export async function reconcileAllEventReadiness(now = new Date()) {
  const events = await db.event.findMany({ where: { startsAt: { gte: now }, canceled: false }, select: { id: true } });
  const results = [];
  for (const event of events) results.push(await reconcileEventReadiness(event.id, now));
  return results;
}
