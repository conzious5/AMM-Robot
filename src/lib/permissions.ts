import type { Administrator, AdminRole } from "@prisma/client";

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
  if (role === "OWNER") return true;
  if (role === "ADMIN") return !["production:enable", "audit:delete"].includes(permission);
  return projectManagerPermissions.has(permission);
}

export function assertPermission(admin: Pick<Administrator, "role">, permission: Permission) {
  if (!hasPermission(admin.role, permission)) throw new Error("You do not have permission to perform this action.");
}
