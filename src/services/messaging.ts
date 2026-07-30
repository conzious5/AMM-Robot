import { Resend } from "resend";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { issueConfirmationToken } from "@/lib/confirmation";
import { planAssignmentReminders, reminderDailySlotKey } from "@/lib/reminders";
import { helpMenu } from "@/services/inbound";
import { resolveCommunicationServiceStatus } from "@/services/service-control";
import { localDayBounds, nextUnoccupiedLocalDay } from "@/lib/quiet-hours";
import { addMinutes } from "date-fns";

const logoUrl = "https://authentic-moments.com/wp-content/uploads/2023/12/Authentic-Moments-Website-Logo-v3.png";

export async function sendPlannedAction(actionId: string) {
  const result = await db.$transaction(async tx => {
    const action = await tx.plannedAction.findUniqueOrThrow({ where: { id: actionId }, include: { assignment: { include: { event: true, person: true } }, person: true } });
    if (!["PLANNED", "QUEUED", "FAILED"].includes(action.status)) return action;
    const assignment = action.assignment;
    const person = assignment?.person ?? action.person;
    const now = new Date();
    if (!person || !person.active || (assignment && (!assignment.active || assignment.event.canceled || assignment.event.startsAt <= now || assignment.confirmationStatus === "CONFIRMED"))) {
      return tx.plannedAction.update({ where: { id: action.id }, data: { status: "SUPPRESSED", lastError: "Recipient or assignment is ineligible" } });
    }
    const config = env();
    if (!config.TEST_MODE) {
      const [launch, service] = await Promise.all([
        tx.setting.findUnique({ where: { key: "production-launch" } }),
        tx.setting.findUnique({ where: { key: "communication-service" } }),
      ]);
      const launchState = launch?.value as { status?: string } | null;
      const serviceStatus = resolveCommunicationServiceStatus(service?.value, launch?.value);
      if (!launchState || serviceStatus !== "ACTIVE") {
        return tx.plannedAction.update({
          where: { id: action.id },
          data: { status: "PLANNED", jobQueueId: null, lastError: "Communication service is suspended by the owner" },
        });
      }
    }
    if (config.GLOBAL_COMMUNICATIONS_PAUSED || person.paused || assignment?.paused || assignment?.event.paused) {
      return tx.plannedAction.update({ where: { id: action.id }, data: { status: "SUPPRESSED", lastError: "Communications paused" } });
    }
    if (assignment && ["REMINDER", "ESCALATE"].includes(action.type)) {
      const slotKey = reminderDailySlotKey(person.id, now, person.timezone);
      await tx.$queryRaw`
        SELECT 1::int AS "locked"
        FROM pg_advisory_xact_lock(hashtext(${slotKey}))
      `;
      const [slot, bounds] = await Promise.all([
        tx.setting.findUnique({ where: { key: slotKey } }),
        Promise.resolve(localDayBounds(now, person.timezone)),
      ]);
      const slotValue = slot?.value as { actionId?: string } | undefined;
      const completedToday = await tx.plannedAction.findFirst({
        where: {
          personId: person.id,
          id: { not: action.id },
          type: { in: ["REMINDER", "ESCALATE"] },
          status: "COMPLETED",
          completedAt: { gte: bounds.start, lt: bounds.end },
        },
        select: { id: true },
      });
      if ((slotValue?.actionId && slotValue.actionId !== action.id) || completedToday) {
        const rescheduledFor = nextUnoccupiedLocalDay(addMinutes(now, 5), person.timezone, new Set([
          slotKey.slice(slotKey.lastIndexOf(":") + 1),
        ]));
        const held = await tx.plannedAction.update({
          where: { id: action.id },
          data: {
            status: "PLANNED",
            scheduledFor: rescheduledFor,
            jobQueueId: null,
            lastError: "Rescheduled: contractor already received a reminder today",
          },
        });
        await tx.assignment.update({ where: { id: assignment.id }, data: { nextReminderAt: rescheduledFor } });
        return held;
      }
      if (!slot) {
        await tx.setting.create({
          data: {
            key: slotKey,
            value: { actionId: action.id, claimedAt: now.toISOString() },
          },
        });
      }
    }
    const token = assignment && ["REMINDER", "ESCALATE"].includes(action.type)
      ? await issueConfirmationToken(assignment.id)
      : null;
    const url = token ? `${config.APP_URL}/confirm/${token}` : "";
    let body = action.messagePreview.replace("[secure confirmation link]", url);
    const optOutAcknowledgment = action.type === "AGENT_REPLY" && /^You have been opted out\b/i.test(body);
    if (action.channel === "SMS" && action.type === "REMINDER" && assignment) {
      const menuAlreadySent = await tx.message.findFirst({
        where: {
          personId: person.id,
          channel: "SMS",
          direction: "OUTBOUND",
          textContent: { contains: "SCHEDULE — upcoming ceremony dates" },
        },
        select: { id: true },
      });
      if (!menuAlreadySent) body = `${body}\n\n${helpMenu}`;
    }
    const conversation = await tx.conversation.upsert({ where: { personId_channel: { personId: person.id, channel: action.channel } }, update: { lastMessageAt: new Date() }, create: { personId: person.id, channel: action.channel } });
    let providerId: string;
    let recipient: string;
    if (action.channel === "EMAIL") {
      if (!person.emailEligible || !person.email) throw new Error("Email recipient is unavailable");
      recipient = config.TEST_MODE ? config.TEST_EMAIL_RECIPIENT ?? "" : person.email;
      if (!recipient) throw new Error("Test email recipient is not configured");
      const prefix = config.TEST_MODE ? `[TEST for ${person.email}] ` : "";
      const defaultSubject = ["REMINDER", "ESCALATE"].includes(action.type)
        ? "Please confirm your assignment"
        : "A message from Authentic Moments";
      const subject = `${prefix}${action.subjectPreview ?? defaultSubject}`;
      const result = await new Resend(config.RESEND_API_KEY).emails.send({
        from: config.TEST_MODE ? "Authentic Moments Scheduling <onboarding@resend.dev>" : config.EMAIL_FROM,
        to: recipient, replyTo: config.EMAIL_REPLY_DOMAIN ? `reply+${conversation.id}@${config.EMAIL_REPLY_DOMAIN}` : undefined,
        subject,
        text: `${prefix}${body}`,
        html: brandedEmailHtml({
          preheader: subject,
          title: ["REMINDER", "ESCALATE"].includes(action.type)
            ? "Please confirm your assignment"
            : "A message from Authentic Moments",
          body: prefix + (url ? body.replaceAll(url, "").trim() : body),
          confirmationUrl: url,
        }),
        headers: { "Idempotency-Key": action.idempotencyKey },
      });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Resend rejected message");
      providerId = result.data.id;
    } else if (action.channel === "SMS") {
      if ((!person.smsEligible && !optOutAcknowledgment) || !person.phone) throw new Error("SMS recipient is unavailable");
      recipient = config.TEST_MODE ? config.TEST_SMS_RECIPIENT ?? "" : person.phone;
      if (!recipient) throw new Error("Test SMS recipient is not configured");
      const prefix = config.TEST_MODE ? `[TEST for ${person.phone}] ` : "";
      const response = await fetch(`${config.QUO_API_BASE_URL}/messages`, { method: "POST", headers: { Authorization: config.QUO_API_KEY ?? "", "Content-Type": "application/json", "Idempotency-Key": action.idempotencyKey }, body: JSON.stringify({ from: config.QUO_PHONE_NUMBER, to: [recipient], content: prefix + body }) });
      if (!response.ok) throw new Error(`Quo rejected message (${response.status})`);
      const result = await response.json() as { data?: { id?: string }; id?: string };
      providerId = result.data?.id ?? result.id ?? "";
      if (!providerId) throw new Error("Quo response did not include a message ID");
    } else throw new Error("Unsupported channel");
    const sentAt = new Date();
    await tx.message.create({ data: { conversationId: conversation.id, personId: person.id, eventId: assignment?.eventId, assignmentId: assignment?.id, direction: "OUTBOUND", channel: action.channel, provider: action.channel === "EMAIL" ? "RESEND" : "QUO", providerMessageId: providerId, sender: action.channel === "EMAIL" ? config.EMAIL_FROM : config.QUO_PHONE_NUMBER ?? "", recipient, subject: action.subjectPreview, textContent: body, deliveryStatus: "ACCEPTED", authorType: action.type === "AGENT_REPLY" ? "SCHEDULING_AGENT" : "REMINDER_SYSTEM", idempotencyKey: action.idempotencyKey, sentAt } });
    if (assignment && ["REMINDER", "ESCALATE"].includes(action.type)) {
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { lastReminderAt: sentAt, nextReminderAt: null, reminderCount: { increment: 1 } },
      });
    }
    return tx.plannedAction.update({ where: { id: action.id }, data: { status: "COMPLETED", completedAt: new Date(), attemptCount: { increment: 1 } } });
  });
  if (
    result.assignmentId &&
    result.status === "COMPLETED" &&
    ["REMINDER", "ESCALATE"].includes(result.type)
  ) {
    await planAssignmentReminders(result.assignmentId);
  }
  return result;
}

export async function sendReminderPreview(channel: "EMAIL" | "SMS" | "BOTH" = "BOTH") {
  const config = env();
  const assignment = await db.assignment.findFirst({
    where: {
      active: true,
      person: { active: true, paused: false },
      event: { startsAt: { gt: new Date() }, canceled: false, status: "SCHEDULED" },
    },
    include: { event: true },
    orderBy: { event: { startsAt: "asc" } },
  });
  if (!assignment) throw new Error("No future ceremony assignment is available for the preview.");
  const event = assignment.event;

  const recipientEmail = config.TEST_EMAIL_RECIPIENT;
  const recipientPhone = config.TEST_SMS_RECIPIENT;
  const date = event.startsAt.toLocaleDateString("en-US", { timeZone: event.timezone, dateStyle: "long" });
  const location = [event.venueName, event.address].filter(Boolean).join(", ") || "location details pending";
  const role = assignment.role === "VIDEOGRAPHER" ? "video" : "photo";
  const confirmationUrl = `${config.APP_URL}/confirm/test?role=${role}`;
  const subject = `[TEST] Please confirm your event on ${date}`;
  const emailBody = `Hello!\n\nThis is a test of the Authentic Moments 4-week reminder.\n\nEvent: ${event.name}\nDate: ${date}\nLocation: ${location}\nRole: ${assignment.role.toLowerCase()}\n\nPlease review the details and confirm your assignment.`;
  const smsBody = `[TEST] Authentic Moments: Your event is one week away. ${event.name} is on ${date} at ${location}. Please confirm: ${confirmationUrl}`;

  const sends: Promise<unknown>[] = [];
  if (channel !== "SMS") {
    sends.push((async () => {
      if (!config.RESEND_API_KEY) throw new Error("Resend API key is not configured");
      if (!recipientEmail) throw new Error("Test email recipient is not configured");
      const result = await new Resend(config.RESEND_API_KEY).emails.send({
        from: "Authentic Moments Scheduling <onboarding@resend.dev>",
        to: recipientEmail,
        subject,
        text: `${emailBody}\n\nConfirm assignment: ${confirmationUrl}`,
        html: brandedEmailHtml({
          preheader: subject,
          title: "Your event is coming up",
          body: emailBody,
          confirmationUrl,
        }),
      });
      if (result.error || !result.data) throw new Error(`Email: ${result.error?.message ?? "Resend rejected message"}`);
      return result.data.id;
    })());
  }
  if (channel !== "EMAIL") {
    sends.push((async () => {
      if (!config.QUO_API_KEY || !config.QUO_PHONE_NUMBER) throw new Error("Quo sender is not configured");
      if (!recipientPhone) throw new Error("Test SMS recipient is not configured");
      const response = await fetch(`${config.QUO_API_BASE_URL}/messages`, {
        method: "POST",
        headers: { Authorization: config.QUO_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.QUO_PHONE_NUMBER, to: [recipientPhone], content: smsBody }),
      });
      if (!response.ok) throw new Error(`SMS: Quo rejected message (${response.status})`);
      return response.text();
    })());
  }
  const results = await Promise.allSettled(sends);

  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
  if (errors.length) throw new Error(errors.join("; "));
}

export function brandedEmailHtml({
  preheader,
  title,
  body,
  confirmationUrl,
}: {
  preheader: string;
  title: string;
  body: string;
  confirmationUrl?: string;
}) {
  const safeBody = escapeHtml(body)
    .replace(/https:\/\/[^\s<]+/g, url => `<a href="${url}" style="color:#003566;font-weight:700">${url}</a>`)
    .replaceAll("\n", "<br>");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f0e8;color:#001d3d;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f0e8">
    <tr>
      <td align="center" style="padding:28px 12px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 28px rgba(0,29,61,.12)">
          <tr>
            <td align="center" style="background:#001d3d;padding:30px 28px 24px;border-bottom:5px solid #ffc300">
              <img src="${logoUrl}" width="360" alt="Authentic Moments Photo &amp; Video" style="display:block;width:100%;max-width:360px;height:auto;border:0">
            </td>
          </tr>
          <tr>
            <td style="padding:38px 42px 18px">
              <p style="margin:0 0 10px;color:#a97a45;font-size:12px;line-height:18px;font-weight:700;letter-spacing:2px;text-transform:uppercase">Crew confirmation</p>
              <h1 style="margin:0;color:#001d3d;font-size:30px;line-height:38px;font-weight:700">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 42px 8px">
              <div style="background:#f8f6f0;border-left:4px solid #ffc300;border-radius:8px;padding:22px 24px;color:#26384a;font-size:16px;line-height:26px">${safeBody}</div>
            </td>
          </tr>
          ${confirmationUrl ? `<tr>
            <td align="center" style="padding:24px 42px 38px">
              <a href="${escapeHtml(confirmationUrl)}" style="display:inline-block;background:#ffc300;color:#001d3d;text-decoration:none;font-size:16px;line-height:20px;font-weight:700;padding:15px 28px;border-radius:7px">Confirm Assignment</a>
              <p style="margin:16px 0 0;color:#6b7785;font-size:12px;line-height:18px">Opening the link does not confirm you. Review the details, then press Confirm Assignment.</p>
            </td>
          </tr>` : ""}
          <tr>
            <td align="center" style="background:#003566;padding:24px 30px;color:#ffffff;font-size:12px;line-height:19px">
              <strong style="font-size:13px">Authentic Moments Media</strong><br>
              Bold, vibrant, authentic wedding photo &amp; video.<br>
              <a href="https://authentic-moments.com/" style="color:#ffd60a;text-decoration:none">authentic-moments.com</a>
              &nbsp;&bull;&nbsp;
              <a href="mailto:hello@authentic-moments.com" style="color:#ffd60a;text-decoration:none">hello@authentic-moments.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
