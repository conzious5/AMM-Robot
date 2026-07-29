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
    await applyPersonnelOverrides();
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
            if (["danielle tolson", "craig babineau"].includes(person.displayName.trim().toLowerCase())) {
              stats.skipped++;
              continue;
            }
            const role = assignmentRole(source.role);
            const externalAssignment = source.id
              ? await db.assignment.findUnique({ where: { externalAssignmentId: source.id } })
              : null;
            const assignment = externalAssignment
              ? await db.assignment.update({
                  where: { id: externalAssignment.id },
                  data: { eventId: event.id, personId: person.id, role, active: true, source: "VSCO" },
                })
              : await db.assignment.upsert({
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
    await archiveNonCeremonyEvents();
    return await db.syncRun.update({ where: { id: run.id }, data: { completedAt: new Date(), status: stats.failed ? "PARTIAL" : "SUCCEEDED", itemsFetched: stats.fetched, itemsCreated: stats.created, itemsUpdated: stats.updated, itemsSkipped: stats.skipped, itemsFailed: stats.failed, details: stats } });
  } catch (error) {
    await db.syncRun.update({ where: { id: run.id }, data: { completedAt: new Date(), status: "FAILED", errorSummary: error instanceof Error ? error.message : "Unknown error", details: stats } });
    throw error;
  }
}

async function applyPersonnelOverrides() {
  const danielle = await db.person.findFirst({ where: { displayName: { equals: "Danielle Tolson", mode: "insensitive" } } });
  if (danielle) {
    await db.plannedAction.updateMany({
      where: { personId: danielle.id, status: { in: ["PLANNED", "QUEUED"] } },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await db.assignment.updateMany({ where: { personId: danielle.id }, data: { active: false, paused: true } });
    await db.person.update({
      where: { id: danielle.id },
      data: {
        active: false,
        paused: true,
        emailEligible: false,
        smsEligible: false,
        email: null,
        normalizedEmail: null,
        phone: null,
        notes: "[DO_NOT_CONTACT_REMOVED] Removed by administrator.",
      },
    });
  }
  const craig = await db.person.findFirst({ where: { displayName: { equals: "Craig Babineau", mode: "insensitive" } } });
  if (craig) {
    await db.plannedAction.updateMany({
      where: { personId: craig.id, status: { in: ["PLANNED", "QUEUED"] } },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await db.assignment.updateMany({ where: { personId: craig.id }, data: { active: false, paused: true } });
    await db.person.update({ where: { id: craig.id }, data: { active: false, paused: true } });
  }
}

async function archiveNonCeremonyEvents() {
  const events = await db.event.findMany({
    where: { vscoEventId: { not: null }, canceled: false },
    select: { id: true, rawProviderPayload: true },
  });
  for (const event of events) {
    const raw = event.rawProviderPayload as { name?: unknown } | null;
    if (typeof raw?.name === "string" && raw.name.trim().toLowerCase().includes("ceremony")) continue;
    await db.plannedAction.updateMany({
      where: { eventId: event.id, status: { in: ["PLANNED", "QUEUED"] } },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await db.assignment.updateMany({ where: { eventId: event.id }, data: { active: false, paused: true } });
    await db.event.update({ where: { id: event.id }, data: { canceled: true, paused: true, status: "CANCELED" } });
  }
}
