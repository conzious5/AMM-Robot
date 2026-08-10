import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./env";
import { db } from "./db";
import { sha256 } from "./crypto";
import { ADMINISTRATOR_EMAIL, isAuthorizedHumanAccount } from "./authorized-users";
import { canAccessAdministrativeArea } from "./permissions";

const SESSION_ISSUER = "amm-robot";
const SESSION_AUDIENCE = "amm-admin";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_ATTEMPT_LIMIT = 10;
const IP_ATTEMPT_LIMIT = 50;
const dummyPasswordHash = bcrypt.hashSync("not-a-real-amm-password", 12);

function sessionCookieName() {
  return env().NODE_ENV === "production" ? "__Host-amm_session" : "amm_session";
}

function signingKey() {
  const secret = env().AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET is required and must contain at least 32 characters");
  return new TextEncoder().encode(secret);
}

function clientIp(requestHeaders: Headers) {
  return requestHeaders.get("cf-connecting-ip")?.trim()
    || requestHeaders.get("x-real-ip")?.trim()
    || requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
    || null;
}

export function authenticationAttemptCountsAreLimited(emailFailures: number, ipFailures: number) {
  return emailFailures >= EMAIL_ATTEMPT_LIMIT || ipFailures >= IP_ATTEMPT_LIMIT;
}

async function authenticationIsRateLimited(emailHash: string, ipHash: string | null, now = new Date()) {
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
  const [emailFailures, ipFailures] = await Promise.all([
    db.authenticationAttempt.count({ where: { kind: "EMAIL", identityHash: emailHash, successful: false, attemptedAt: { gte: since } } }),
    ipHash
      ? db.authenticationAttempt.count({ where: { kind: "IP", identityHash: ipHash, successful: false, attemptedAt: { gte: since } } })
      : Promise.resolve(0),
  ]);
  return authenticationAttemptCountsAreLimited(emailFailures, ipFailures);
}

async function recordAuthenticationAttempt(emailHash: string, ipHash: string | null, successful: boolean) {
  await db.$transaction([
    db.authenticationAttempt.create({ data: { kind: "EMAIL", identityHash: emailHash, successful } }),
    ...(ipHash ? [db.authenticationAttempt.create({ data: { kind: "IP", identityHash: ipHash, successful } })] : []),
  ]);
}

export async function signIn(emailInput: string, password: string) {
  const config = env();
  const normalizedEmail = emailInput.trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 254 || !password || password.length > 256) return false;

  const emailHash = sha256(normalizedEmail);
  const ip = clientIp(await headers());
  const ipHash = ip ? sha256(ip) : null;
  if (await authenticationIsRateLimited(emailHash, ipHash)) return false;

  const admin = await db.administrator.findUnique({ where: { email: normalizedEmail } });

  const validPassword = await bcrypt.compare(password, admin?.passwordHash ?? dummyPasswordHash);
  if (!isAuthorizedHumanAccount(admin) || !validPassword) {
    await recordAuthenticationAttempt(emailHash, ipHash, false);
    return false;
  }

  const token = await new SignJWT({ role: admin.role, ver: admin.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(admin.id)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(signingKey());
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 43200,
    priority: "high",
  });
  if (config.NODE_ENV === "production") cookieStore.delete("amm_session");
  await recordAuthenticationAttempt(emailHash, ipHash, true);
  await db.authenticationAttempt.deleteMany({ where: { attemptedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } });
  await db.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "LOGIN", entityType: "Administrator", entityId: admin.id } });
  return true;
}

export async function currentAdmin() {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token || !env().AUTH_SECRET) return null;
  try {
    const result = await jwtVerify(token, signingKey(), {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (typeof result.payload.sub !== "string") return null;
    const admin = await db.administrator.findUnique({ where: { id: result.payload.sub } });
    if (!sessionPayloadMatchesAdministrator(result.payload, admin)) return null;
    return admin;
  } catch {
    return null;
  }
}

export function sessionPayloadMatchesAdministrator(
  payload: { sub?: unknown; ver?: unknown },
  admin: { id: string; email: string; role: string; active: boolean; sessionVersion: number } | null,
) {
  return Boolean(
    isAuthorizedHumanAccount(admin)
    && typeof payload.sub === "string"
    && payload.sub === admin.id
    && typeof payload.ver === "number"
    && payload.ver === admin.sessionVersion,
  );
}

export async function signOut() {
  const admin = await currentAdmin();
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName());
  cookieStore.delete("amm_session");
  if (admin) {
    await db.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "LOGOUT", entityType: "Administrator", entityId: admin.id } });
  }
}

export async function requireAdmin() {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");
  return admin;
}

export async function requireAdministrator() {
  const admin = await currentAdmin();
  if (!admin || !canAccessAdministrativeArea(admin.role) || admin.email.toLowerCase() !== ADMINISTRATOR_EMAIL) redirect("/");
  return admin;
}
