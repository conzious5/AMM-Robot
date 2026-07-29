import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export function createOpaqueToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}
export function verifyHmac(raw: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.replace(/^sha256=/, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyQuoWebhook(
  raw: string,
  signatureHeader: string,
  signingKey: string,
  now = Date.now(),
  toleranceMs = 5 * 60 * 1000,
) {
  let compactPayload: string;
  try {
    compactPayload = JSON.stringify(JSON.parse(raw));
  } catch {
    return false;
  }

  const key = Buffer.from(signingKey, "base64");
  for (const candidate of signatureHeader.split(",")) {
    const [scheme, version, timestamp, providedDigest] = candidate.trim().split(";");
    if (scheme !== "hmac" || version !== "1" || !timestamp || !providedDigest) continue;
    const timestampNumber = Number(timestamp);
    if (!Number.isFinite(timestampNumber)) continue;
    const timestampMs = timestampNumber < 10_000_000_000 ? timestampNumber * 1000 : timestampNumber;
    if (Math.abs(now - timestampMs) > toleranceMs) continue;

    const expectedDigest = createHmac("sha256", key)
      .update(`${timestamp}.${compactPayload}`)
      .digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(providedDigest, "base64");
    } catch {
      continue;
    }
    if (expectedDigest.length === provided.length && timingSafeEqual(expectedDigest, provided)) return true;
  }
  return false;
}
