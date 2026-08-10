import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyQuoWebhook } from "@/lib/crypto";
import { db } from "@/lib/db";
import { webhooksQueue } from "@/lib/queue";
import { z } from "zod";
import { readLimitedText, RequestBodyTooLargeError } from "@/lib/http-security";

const Envelope = z.object({
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(200)),
  type: z.string().min(1).max(200).optional(),
}).passthrough();

export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readLimitedText(req, 512 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return new NextResponse("Payload too large", { status: 413 });
    throw error;
  }
  const signature = req.headers.get("openphone-signature") ?? "";
  const secret = env().QUO_WEBHOOK_SIGNING_KEY;
  if (!secret || !verifyQuoWebhook(raw, signature, secret)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }
  let body: z.infer<typeof Envelope>;
  try {
    body = Envelope.parse(JSON.parse(raw));
  } catch {
    return new NextResponse("Invalid webhook payload", { status: 400 });
  }
  const row = await db.webhookEvent.upsert({
    where: { provider_providerEventId: { provider: "QUO", providerEventId: body.id } },
    update: {},
    create: { provider: "QUO", providerEventId: body.id, type: body.type ?? "unknown", payload: body as object },
  });
  if (row.status === "QUEUED") {
    await webhooksQueue.add("quo", { webhookEventId: row.id }, { jobId: `quo-${body.id}` });
  }
  return NextResponse.json({ received: true }, { status: 202 });
}
