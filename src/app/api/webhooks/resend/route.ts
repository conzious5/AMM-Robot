import { NextResponse } from "next/server";
import { Resend } from "resend";
import { z } from "zod";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { webhooksQueue } from "@/lib/queue";
import { readLimitedText, RequestBodyTooLargeError } from "@/lib/http-security";

const VerifiedEvent = z.object({ type: z.string().min(1).max(200) }).passthrough();

export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readLimitedText(req, 512 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return new NextResponse("Payload too large", { status: 413 });
    throw error;
  }
  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signature = req.headers.get("svix-signature");
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!id || id.length > 200 || !timestamp || timestamp.length > 100 || !signature || signature.length > 1000 || !secret) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let event: z.infer<typeof VerifiedEvent>;
  try {
    const verified = new Resend(env().RESEND_API_KEY).webhooks.verify({
      payload: raw,
      headers: { id, timestamp, signature },
      webhookSecret: secret,
    });
    event = VerifiedEvent.parse(verified);
  } catch {
    return new NextResponse("Invalid signature", { status: 401 });
  }
  const row = await db.webhookEvent.upsert({
    where: { provider_providerEventId: { provider: "RESEND", providerEventId: id } },
    update: {},
    create: { provider: "RESEND", providerEventId: id, type: event.type, payload: event as object },
  });
  if (row.status === "QUEUED") await webhooksQueue.add("resend", { webhookEventId: row.id }, { jobId: `resend-${id}` });
  return NextResponse.json({ received: true }, { status: 202 });
}
