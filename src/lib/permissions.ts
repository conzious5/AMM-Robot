import type { Administrator, AdminRole } from "@prisma/client";
import { PORTAL_USER_EMAIL } from "@/lib/authorized-users";

export type Permission =
  | "operations:view"
  | "communications:send"
  | "communications:reschedule"
  | "contacts:edit"
  | "assignments:edit"
  | "assignments:status"
  | "notes:edit"
  | "communications:pause"
  | "alerts:resolve"
  | "agent:use"
  | "agent:approve"
  | "settings:notifications"
  | "settings:security"
  | "production:enable"
  | "audit:delete"
  | "records:delete";

const projectManagerPermissions = new Set<Permission>([
  "operations:view",
  "communications:send",
  "communications:reschedule",
  "contacts:edit",
  "assignments:edit",
  "assignments:status",
  "notes:edit",
  "communications:pause",
  "alerts:resolve",
  "agent:use",
  "agent:approve",
  "settings:notifications",
]);

export function hasPermission(role: AdminRole, permission: Permission) {
  if (role === "ADMIN") return true;
  if (role === "OWNER") return false;
  return projectManagerPermissions.has(permission);
}

export function canAccessAdministrativeArea(role: AdminRole) {
  return role === "ADMIN";
}

export function assertPermission(admin: Pick<Administrator, "role">, permission: Permission) {
  if (!hasPermission(admin.role, permission)) throw new Error("You do not have permission to perform this action.");
}

export function canEditProjectManagerProfile(
  actor: Pick<Administrator, "id" | "role"> | null,
  target: Pick<Administrator, "id" | "role" | "email">,
) {
  if (!actor) return false;
  return target.role === "PROJECT_MANAGER"
    && target.email.toLowerCase() === PORTAL_USER_EMAIL
    && (actor.role === "ADMIN" || (actor.role === "PROJECT_MANAGER" && actor.id === target.id));
}

export function assertCanEditProjectManagerProfile(
  actor: Pick<Administrator, "id" | "role"> | null,
  target: Pick<Administrator, "id" | "role" | "email">,
) {
  if (!canEditProjectManagerProfile(actor, target)) {
    throw new Error("You do not have permission to update that administrator profile.");
  }
}
