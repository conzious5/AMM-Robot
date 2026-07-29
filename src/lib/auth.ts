import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./env";
import { db } from "./db";

const key = () => new TextEncoder().encode(env().AUTH_SECRET);
export async function signIn(email: string, password: string) {
  const admin = await db.administrator.findUnique({ where: { email: email.toLowerCase() } });
  if (!admin?.active || !(await bcrypt.compare(password, admin.passwordHash))) return false;
  const token = await new SignJWT({ sub: admin.id, role: admin.role }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("12h").sign(key());
  (await cookies()).set("amm_session", token, { httpOnly: true, secure: env().NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 43200 });
  await db.auditLog.create({ data: { actorType: "ADMIN", actorId: admin.id, action: "LOGIN", entityType: "Administrator", entityId: admin.id } });
  return true;
}
export async function currentAdmin() {
  const token = (await cookies()).get("amm_session")?.value;
  if (!token || !env().AUTH_SECRET) return null;
  try { const result = await jwtVerify(token, key()); return db.administrator.findUnique({ where: { id: result.payload.sub } }); } catch { return null; }
}
export async function requireAdmin() { const admin = await currentAdmin(); if (!admin) redirect("/login"); return admin; }
