import { addDays } from "date-fns";
import { parsePhoneNumber } from "libphonenumber-js";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { planAssignmentReminders } from "@/lib/reminders";
import { VscoWorkspaceProvider } from "@/providers/vsco";

const assignmentRole = (role: string) => role.toLowerCase().includes("video") ? "VIDEOGRAPHER" as const : role.toLowerCase().includes("photo") ? "PHOTOGRAPHER" as const : "OTHER" as const;
export async function runVscoSync(provider = new VscoWorkspaceProvider()) {
  const run = await db.syncRun.create({ data: { provider: "VSCO", status: "RUNNING" } });
  const stats = { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0, warnings: [] as string[] };
  try {
    for await (const page of provider.events({ from: addDays(new Date(), -env().VSCO_SYNC_HISTORY_DAYS), to: addDays(new Date(), env().VSCO_SYNC_FUTURE_DAYS) })) {
      for (const item of page.events) {
        stats.fetched++;
        try {
          const existing = await db.event.findUnique({ where: { vscoEventId: item.externalId }, include: { assignments: true } });
          const event = await db.event.upsert({
            where: { vscoEventId: item.externalId },
            update: { vscoJobId: item.jobId, name: item.name, eventType: item.eventType, startsAt: item.startsAt, endsAt: item.endsAt, timezone: item.timezone, venueName: item.venueName, address: item.address, canceled: item.canceled, status: item.canceled ? "CANCELED" : "SCHEDULED", rawProviderPayload: item.raw as object, lastSyncedAt: new Date() },
            create: { vscoEventId: item.externalId, vscoJobId: item.jobId, name: item.name, eventType: item.eventType, startsAt: item.startsAt, endsAt: item.endsAt, timezone: item.timezone, venueName: item.venueName, address: item.address, canceled: item.canceled, status: item.canceled ? "CANCELED" : "SCHEDULED", rawProviderPayload: item.raw as object, lastSyncedAt: new Date() },
          });
          if (existing) stats.updated++;
          else stats.created++;
          if (existing && existing.startsAt.getTime() !== item.startsAt.getTime()) {
            await db.eventChange.create({ data: { eventId: event.id, field: "startsAt", oldValue: existing.startsAt.toISOString(), newValue: item.startsAt.toISOString(), source: "VSCO" } });
            await db.plannedAction.updateMany({ where: { eventId: event.id, status: { in: ["PLANNED", "QUEUED"] } }, data: { status: "CANCELED", canceledAt: new Date() } });
          }
          if (item.assignments === null) {
            stats.warnings.push(`Event ${item.externalId}: team assignments were not present in the API response`);
            continue;
          }
          const seen = new Set<string>();
          for (const source of item.assignments) {
            const member = source.teamMember;
            const email = member.email?.trim().toLowerCase();
            const phone = member.phone ? parsePhoneNumber(member.phone, "US").number : undefined;
            let person = member.id ? await db.person.findUnique({ where: { vscoExternalId: member.id } }) : null;
            if (!person && email) person = await db.person.findUnique({ where: { normalizedEmail: email } });
            if (!person && phone) person = await db.person.findUnique({ where: { phone } });
            if (!person) person = await db.person.create({ data: { vscoExternalId: member.id, firstName: member.firstName, lastName: member.lastName, displayName: member.name ?? `${member.firstName} ${member.lastName}`.trim(), email: member.email, normalizedEmail: email, phone, role: assignmentRole(source.role) === "VIDEOGRAPHER" ? "VIDEOGRAPHER" : "PHOTOGRAPHER", rawProviderPayload: member } });
            const role = assignmentRole(source.role);
            const assignment = await db.assignment.upsert({
              where: { eventId_personId_role: { eventId: event.id, personId: person.id, role } },
              update: { active: true, externalAssignmentId: source.id, source: "VSCO" },
              create: { eventId: event.id, personId: person.id, role, source: "VSCO", externalAssignmentId: source.id, confirmationStatus: "PENDING" },
            });
            seen.add(assignment.id);
            await planAssignmentReminders(assignment.id);
          }
          for (const old of existing?.assignments ?? []) if (old.source === "VSCO" && old.active && !seen.has(old.id)) {
            await db.assignment.update({ where: { id: old.id }, data: { active: false, needsAttention: true } });
            await db.plannedAction.updateMany({ where: { assignmentId: old.id, status: { in: ["PLANNED", "QUEUED"] } }, data: { status: "CANCELED", canceledAt: new Date() } });
          }
        } catch (error) { stats.failed++; stats.warnings.push(error instanceof Error ? error.message : "Unknown sync error"); }
      }
      await db.syncRun.update({ where: { id: run.id }, data: { cursor: page.cursor } });
    }
    return await db.syncRun.update({ where: { id: run.id }, data: { completedAt: new Date(), status: stats.failed ? "PARTIAL" : "SUCCEEDED", itemsFetched: stats.fetched, itemsCreated: stats.created, itemsUpdated: stats.updated, itemsSkipped: stats.skipped, itemsFailed: stats.failed, details: stats } });
  } catch (error) {
    await db.syncRun.update({ where: { id: run.id }, data: { completedAt: new Date(), status: "FAILED", errorSummary: error instanceof Error ? error.message : "Unknown error", details: stats } });
    throw error;
  }
}
