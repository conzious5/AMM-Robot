import { Resend } from "resend";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { launchIncludedEventWhere } from "@/lib/launch-cutoff";

type NotificationInput = {
  eventId?: string;
  type: string;
  subject: string;
  body: string;
  deduplicationKey: string;
};

export function projectManagerNotificationKey(base: string, administratorId: string, channel: "EMAIL" | "SMS") {
  return `${base}:${administratorId}:${channel}`;
}

export function groupEventsForBrief<T extends { readinessStatus: string }>(events: T[]) {
  return {
    ready: events.filter(event => event.readinessStatus === "READY"),
    waiting: events.filter(event => event.readinessStatus === "WAITING_FOR_CONFIRMATION"),
    atRisk: events.filter(event => ["AT_RISK", "INCOMPLETE", "CHANGED_SINCE_CONFIRMATION"].includes(event.readinessStatus)),
  };
}

export async function notifyProjectManagers(input: NotificationInput) {
  const managers = await db.administrator.findMany({
    where: { active: true, role: "PROJECT_MANAGER" },
  });
  const results = [];
  for (const manager of managers) {
    const channels = manager.notificationChannel === "BOTH"
      ? ["EMAIL", "SMS"] as const
      : [manager.notificationChannel] as const;
    for (const channel of channels) {
      const key = projectManagerNotificationKey(input.deduplicationKey, manager.id, channel);
      const existing = await db.projectManagerNotification.findUnique({ where: { deduplicationKey: key } });
      if (existing) {
        results.push(existing);
        continue;
      }
      const notification = await db.projectManagerNotification.create({
        data: {
          administratorId: manager.id,
          eventId: input.eventId,
          type: input.type,
          channel,
          subject: channel === "EMAIL" ? input.subject : null,
          body: input.body,
          deduplicationKey: key,
        },
      });
      try {
        const config = env();
        if (channel === "EMAIL") {
          const recipient = config.TEST_MODE ? config.TEST_EMAIL_RECIPIENT : manager.email;
          if (!recipient || !config.RESEND_API_KEY) throw new Error("Project-manager email delivery is not configured");
          const result = await new Resend(config.RESEND_API_KEY).emails.send({
            from: config.TEST_MODE ? "Authentic Moments Operations <onboarding@resend.dev>" : config.EMAIL_FROM,
            to: recipient,
            subject: config.TEST_MODE ? `[TEST for ${manager.email}] ${input.subject}` : input.subject,
            text: input.body,
            headers: { "Idempotency-Key": key },
          });
          if (result.error || !result.data) throw new Error(result.error?.message ?? "Resend rejected project-manager notification");
          results.push(await db.projectManagerNotification.update({
            where: { id: notification.id },
            data: { status: "SENT", providerMessageId: result.data.id, sentAt: new Date() },
          }));
        } else {
          const recipient = config.TEST_MODE ? config.TEST_SMS_RECIPIENT : manager.phone;
          if (!recipient || !config.QUO_API_KEY || !config.QUO_PHONE_NUMBER) throw new Error("Project-manager SMS delivery is not configured");
          const response = await fetch(`${config.QUO_API_BASE_URL}/messages`, {
            method: "POST",
            headers: {
              Authorization: config.QUO_API_KEY,
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify({ from: config.QUO_PHONE_NUMBER, to: [recipient], content: input.body }),
          });
          if (!response.ok) throw new Error(`Quo rejected project-manager notification (${response.status})`);
          const payload = await response.json() as { data?: { id?: string }; id?: string };
          results.push(await db.projectManagerNotification.update({
            where: { id: notification.id },
            data: { status: "SENT", providerMessageId: payload.data?.id ?? payload.id, sentAt: new Date() },
          }));
        }
      } catch (error) {
        results.push(await db.projectManagerNotification.update({
          where: { id: notification.id },
          data: { status: "FAILED", failureReason: error instanceof Error ? error.message : "Notification failed" },
        }));
      }
    }
  }
  return results;
}

export async function sendReadyNotification(eventId: string, transitionKey: string) {
  const event = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    include: { assignments: { where: { active: true }, include: { person: true } } },
  });
  const date = formatInTimeZone(event.startsAt, event.timezone, "MMMM d, yyyy");
  const photography = event.assignments.filter(item => item.role === "PHOTOGRAPHER").map(item => item.person.displayName).join(", ") || "Not required";
  const videography = event.assignments.filter(item => item.role === "VIDEOGRAPHER").map(item => item.person.displayName).join(", ") || "Not required";
  const body = `${event.name} is fully staffed and confirmed.

Photography: ${photography}
Videography: ${videography}
Date: ${date}
Venue: ${event.venueName ?? "Venue pending"}

All required assignments are confirmed.

Open in AMM Robot: ${env().APP_URL}/operations#event-${event.id}`;
  return notifyProjectManagers({
    eventId,
    type: "EVENT_READY",
    subject: `Ready: ${event.name} on ${date}`,
    body,
    deduplicationKey: `ready:${event.id}:${transitionKey}`,
  });
}

export async function maybeSendProjectManagerDailyBrief(now = new Date()) {
  const managers = await db.administrator.findMany({
    where: { active: true, role: "PROJECT_MANAGER", dailyBriefEnabled: true },
  });
  const timezone = env().DEFAULT_TIMEZONE;
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const currentTime = formatInTimeZone(now, timezone, "HH:mm");
  const sent = [];
  for (const manager of managers) {
    if (currentTime < manager.dailyBriefTime) continue;
    const deduplicationKey = `daily-brief:${manager.id}:${today}`;
    if (await db.projectManagerDailyBrief.findUnique({ where: { deduplicationKey } })) continue;
    const previous = await db.projectManagerDailyBrief.findFirst({
      where: { administratorId: manager.id, status: "SENT" },
      orderBy: { periodEnd: "desc" },
    });
    const periodStart = previous?.periodEnd ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const report = await buildDailyBrief(periodStart, now);
    const record = await db.projectManagerDailyBrief.create({
      data: {
        administratorId: manager.id,
        periodStart,
        periodEnd: now,
        deduplicationKey,
        subject: `Authentic Moments operations brief — ${formatInTimeZone(now, timezone, "MMMM d, yyyy")}`,
        body: report,
        status: "PLANNED",
      },
    });
    try {
      const config = env();
      const recipient = config.TEST_MODE ? config.TEST_EMAIL_RECIPIENT : manager.email;
      if (!recipient || !config.RESEND_API_KEY) throw new Error("Daily brief email is not configured");
      const result = await new Resend(config.RESEND_API_KEY).emails.send({
        from: config.TEST_MODE ? "Authentic Moments Operations <onboarding@resend.dev>" : config.EMAIL_FROM,
        to: recipient,
        subject: config.TEST_MODE ? `[TEST for ${manager.email}] ${record.subject}` : record.subject,
        text: report,
        headers: { "Idempotency-Key": deduplicationKey },
      });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Resend rejected daily brief");
      sent.push(await db.projectManagerDailyBrief.update({
        where: { id: record.id },
        data: { status: "SENT", providerMessageId: result.data.id, sentAt: now },
      }));
    } catch (error) {
      sent.push(await db.projectManagerDailyBrief.update({
        where: { id: record.id },
        data: { status: `FAILED: ${error instanceof Error ? error.message : "Unknown failure"}` },
      }));
    }
  }
  return sent;
}

export async function buildDailyBrief(periodStart: Date, now = new Date()) {
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [events, alerts, declines, failures, actions, readySince, overdueTasks] = await Promise.all([
    db.event.findMany({ where: { startsAt: { gte: now, lte: end }, canceled: false, ...launchIncludedEventWhere }, orderBy: { startsAt: "asc" } }),
    db.operationalAlert.findMany({ where: { status: "OPEN" }, include: { event: true, person: true }, orderBy: { firstSeenAt: "asc" } }),
    db.assignment.findMany({ where: { declinedAt: { gte: periodStart }, active: true }, include: { event: true, person: true } }),
    db.message.findMany({ where: { createdAt: { gte: periodStart }, deliveryStatus: { in: ["FAILED", "BOUNCED"] } }, include: { person: true, event: true } }),
    db.plannedAction.findMany({ where: { status: { in: ["PLANNED", "QUEUED"] }, scheduledFor: { gte: now, lte: end } }, include: { event: true, person: true }, orderBy: { scheduledFor: "asc" }, take: 20 }),
    db.auditLog.findMany({ where: { action: "EVENT_READINESS_CHANGED", createdAt: { gte: periodStart }, after: { path: ["status"], equals: "READY" } }, take: 50 }),
    db.operationalTask.findMany({ where: { criticalForReadiness: true, status: "OVERDUE" }, include: { event: true } }),
  ]);
  const { ready, waiting, atRisk } = groupEventsForBrief(events);
  const nextSeven = events.filter(event => event.startsAt <= sevenDays);
  const line = (event: (typeof events)[number]) =>
    `- ${event.name} — ${formatInTimeZone(event.startsAt, event.timezone, "MMM d")} — ${event.readinessStatus.replaceAll("_", " ").toLowerCase()}`;
  const sections = [
    `Authentic Moments project-manager brief`,
    ``,
    `Priority: next 7 days`,
    ...(nextSeven.length ? nextSeven.map(line) : ["- No events in the next 7 days."]),
    ``,
    `Became ready since the previous brief: ${readySince.length}`,
    `Upcoming ready events: ${ready.length}`,
    ...ready.slice(0, 10).map(line),
    ``,
    `Waiting for confirmation: ${waiting.length}`,
    ...waiting.slice(0, 10).map(line),
    ``,
    `At risk / incomplete / changed: ${atRisk.length}`,
    ...atRisk.slice(0, 10).map(line),
    ``,
    `Unresolved alerts: ${alerts.length}`,
    ...alerts.slice(0, 10).map(alert => `- ${alert.event?.name ?? "Operations"}: ${alert.reason}`),
    ``,
    `Recent declines or conflicts: ${declines.length}`,
    ...declines.slice(0, 10).map(item => `- ${item.person.displayName}: ${item.event.name}`),
    ``,
    `Failed deliveries: ${failures.length}`,
    ...failures.slice(0, 10).map(item => `- ${item.person.displayName}: ${item.event?.name ?? "message"} (${item.channel})`),
    ``,
    `Upcoming reminders: ${actions.length}`,
    ...actions.slice(0, 10).map(item => `- ${item.scheduledFor.toLocaleString()}: ${item.person?.displayName ?? "System"} — ${item.event?.name ?? item.reason}`),
    ``,
    `Critical overdue tasks: ${overdueTasks.length}`,
    ...overdueTasks.slice(0, 10).map(item => `- ${item.event?.name ?? item.vscoJobId ?? "Unlinked"}: ${item.name}`),
  ];
  if (!alerts.length && !declines.length && !failures.length && !overdueTasks.length && !atRisk.length && !waiting.length) {
    sections.push("", "All upcoming events are currently staffed and no project-manager intervention is required.");
  } else {
    sections.push("", "Recommended actions:", ...alerts.slice(0, 8).map(alert => `- ${alert.recommendedAction ?? `Review ${alert.reason}`}`));
  }
  sections.push("", `Open Operations: ${env().APP_URL}/operations`);
  return sections.join("\n");
}
