import { Resend } from "resend";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { issueConfirmationToken } from "@/lib/confirmation";

export async function sendPlannedAction(actionId: string) {
  return db.$transaction(async tx => {
    const action = await tx.plannedAction.findUniqueOrThrow({ where: { id: actionId }, include: { assignment: { include: { event: true, person: true } }, person: true } });
    if (!["PLANNED", "QUEUED", "FAILED"].includes(action.status)) return action;
    const assignment = action.assignment;
    const person = assignment?.person ?? action.person;
    if (!person || (assignment && (!assignment.active || assignment.event.canceled || assignment.confirmationStatus === "CONFIRMED"))) {
      return tx.plannedAction.update({ where: { id: action.id }, data: { status: "SUPPRESSED", lastError: "Recipient or assignment is ineligible" } });
    }
    const config = env();
    if (config.GLOBAL_COMMUNICATIONS_PAUSED || person.paused || assignment?.paused || assignment?.event.paused) {
      return tx.plannedAction.update({ where: { id: action.id }, data: { status: "SUPPRESSED", lastError: "Communications paused" } });
    }
    const token = assignment ? await issueConfirmationToken(assignment.id) : null;
    const url = token ? `${config.APP_URL}/confirm/${token}` : "";
    const body = action.messagePreview.replace("[secure confirmation link]", url);
    const conversation = await tx.conversation.upsert({ where: { personId_channel: { personId: person.id, channel: action.channel } }, update: { lastMessageAt: new Date() }, create: { personId: person.id, channel: action.channel } });
    let providerId: string;
    let recipient: string;
    if (action.channel === "EMAIL") {
      if (!person.emailEligible || !person.email) throw new Error("Email recipient is unavailable");
      recipient = config.TEST_MODE ? config.TEST_EMAIL_RECIPIENT ?? "" : person.email;
      if (!recipient) throw new Error("Test email recipient is not configured");
      const prefix = config.TEST_MODE ? `[TEST for ${person.email}] ` : "";
      const result = await new Resend(config.RESEND_API_KEY).emails.send({
        from: config.TEST_MODE ? "Authentic Moments Scheduling <onboarding@resend.dev>" : config.EMAIL_FROM,
        to: recipient, replyTo: config.EMAIL_REPLY_DOMAIN ? `reply+${conversation.id}@${config.EMAIL_REPLY_DOMAIN}` : undefined,
        subject: `${prefix}${action.subjectPreview ?? "Please confirm your assignment"}`, text: `${prefix}${body}`,
        html: `<main style="font-family:Arial;max-width:600px;margin:auto"><p>${escapeHtml(prefix + body).replaceAll("\n", "<br>")}</p>${url ? `<p><a href="${url}" style="background:#1f4438;color:white;padding:12px 20px;text-decoration:none;border-radius:4px;display:inline-block">Confirm Assignment</a></p>` : ""}</main>`,
        headers: { "Idempotency-Key": action.idempotencyKey },
      });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Resend rejected message");
      providerId = result.data.id;
    } else if (action.channel === "SMS") {
      if (!person.smsEligible || !person.phone) throw new Error("SMS recipient is unavailable");
      recipient = config.TEST_MODE ? config.TEST_SMS_RECIPIENT ?? "" : person.phone;
      if (!recipient) throw new Error("Test SMS recipient is not configured");
      const prefix = config.TEST_MODE ? `[TEST for ${person.phone}] ` : "";
      const response = await fetch(`${config.QUO_API_BASE_URL}/messages`, { method: "POST", headers: { Authorization: config.QUO_API_KEY ?? "", "Content-Type": "application/json", "Idempotency-Key": action.idempotencyKey }, body: JSON.stringify({ from: config.QUO_PHONE_NUMBER, to: [recipient], content: prefix + body }) });
      if (!response.ok) throw new Error(`Quo rejected message (${response.status})`);
      const result = await response.json() as { data?: { id?: string }; id?: string };
      providerId = result.data?.id ?? result.id ?? "";
      if (!providerId) throw new Error("Quo response did not include a message ID");
    } else throw new Error("Unsupported channel");
    await tx.message.create({ data: { conversationId: conversation.id, personId: person.id, eventId: assignment?.eventId, assignmentId: assignment?.id, direction: "OUTBOUND", channel: action.channel, provider: action.channel === "EMAIL" ? "RESEND" : "QUO", providerMessageId: providerId, sender: action.channel === "EMAIL" ? config.EMAIL_FROM : config.QUO_PHONE_NUMBER ?? "", recipient, subject: action.subjectPreview, textContent: body, deliveryStatus: "ACCEPTED", authorType: action.type === "AGENT_REPLY" ? "SCHEDULING_AGENT" : "REMINDER_SYSTEM", idempotencyKey: action.idempotencyKey, sentAt: new Date() } });
    return tx.plannedAction.update({ where: { id: action.id }, data: { status: "COMPLETED", completedAt: new Date(), attemptCount: { increment: 1 } } });
  });
}

export async function sendReminderPreview(channel: "EMAIL" | "SMS" | "BOTH" = "BOTH") {
  const config = env();
  const event = await db.event.findFirst({
    where: { startsAt: { gt: new Date() }, canceled: false, status: "SCHEDULED" },
    orderBy: { startsAt: "asc" },
  });
  if (!event) throw new Error("No future ceremony is available for the preview.");

  const recipientEmail = config.TEST_EMAIL_RECIPIENT;
  const recipientPhone = config.TEST_SMS_RECIPIENT;
  const date = event.startsAt.toLocaleDateString("en-US", { timeZone: event.timezone, dateStyle: "long" });
  const location = [event.venueName, event.address].filter(Boolean).join(", ") || "location details pending";
  const confirmationUrl = `${config.APP_URL}/confirm/test`;
  const subject = `[TEST] Please confirm your event on ${date}`;
  const emailBody = `This is a test of the Authentic Moments 4-week reminder.\n\nEvent: ${event.name}\nDate: ${date}\nLocation: ${location}\n\nPlease use the button below to confirm.`;
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
        html: `<main style="font-family:Arial;max-width:600px;margin:auto"><p>${escapeHtml(emailBody).replaceAll("\n", "<br>")}</p><p><a href="${confirmationUrl}" style="background:#1f4438;color:white;padding:12px 20px;text-decoration:none;border-radius:4px;display:inline-block">Confirm Assignment</a></p></main>`,
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

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
