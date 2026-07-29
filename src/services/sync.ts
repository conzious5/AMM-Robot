import { addDays } from "date-fns";
import { parsePhoneNumber } from "libphonenumber-js";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { planAssignmentReminders } from "@/lib/reminders";
import { VscoWorkspaceProvider } from "@/providers/vsco";

const assignmentRole = (role: string) => role.toLowerCase().includes("video") ? "VIDEOGRAPHER" as const : role.toLowerCase().includes("photo") ? "PHOTOGRAPHER" as const : "OTHER" as const;
const removedPersonNames = new Set(["danielle tolson", "seth smith"]);
const deactivatedPersonNames = new Set(["craig babineau"]);
const canonicalPersonNames = new Set(["sean lara"]);
const normalizedName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

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
            const memberName = (member.name ?? `${member.firstName} ${member.lastName}`).trim();
            const memberNameKey = normalizedName(memberName);
            if (removedPersonNames.has(memberNameKey) || deactivatedPersonNames.has(memberNameKey)) {
              stats.skipped++;
              continue;
            }
            const email = member.email?.trim().toLowerCase();
            const phone = member.phone ? parsePhoneNumber(member.phone, "US").number : undefined;
            let person = member.id ? await db.person.findUnique({ where: { vscoExternalId: member.id } }) : null;
            if (!person && email) person = await db.person.findUnique({ where: { normalizedEmail: email } });
            if (!person && phone) person = await db.person.findUnique({ where: { phone } });
            if (!person && canonicalPersonNames.has(memberNameKey)) {
              person = await db.person.findFirst({
                where: { displayName: { equals: memberName, mode: "insensitive" } },
                orderBy: { createdAt: "asc" },
              });
            }
            if (!person) person = await db.person.create({ data: { vscoExternalId: member.id, firstName: member.firstName, lastName: member.lastName, displayName: memberName, email: member.email, normalizedEmail: email, phone, role: assignmentRole(source.role) === "VIDEOGRAPHER" ? "VIDEOGRAPHER" : "PHOTOGRAPHER", rawProviderPayload: member } });
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
  for (const name of ["Danielle Tolson", "Seth Smith"]) await removePerson(name);
  await deactivatePerson("Craig Babineau");
  await mergeDuplicatePeople("Sean Lara");
}

async function removePerson(name: string) {
  const people = await db.person.findMany({ where: { displayName: { equals: name, mode: "insensitive" } } });
  for (const person of people) {
    await db.plannedAction.updateMany({
      where: { personId: person.id, status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] } },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await db.assignment.updateMany({ where: { personId: person.id }, data: { active: false, paused: true, confirmationStatus: "CANCELED" } });
    await db.person.update({
      where: { id: person.id },
      data: {
        active: false,
        paused: true,
        emailEligible: false,
        smsEligible: false,
        email: null,
        normalizedEmail: null,
        phone: null,
        notes: "[DO_NOT_CONTACT_REMOVED] Permanently removed by administrator.",
      },
    });
  }
}

async function deactivatePerson(name: string) {
  const people = await db.person.findMany({ where: { displayName: { equals: name, mode: "insensitive" } } });
  for (const person of people) {
    await db.plannedAction.updateMany({
      where: { personId: person.id, status: { in: ["PLANNED", "QUEUED", "WAITING_FOR_APPROVAL"] } },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await db.assignment.updateMany({ where: { personId: person.id }, data: { active: false, paused: true } });
    await db.person.update({ where: { id: person.id }, data: { active: false, paused: true } });
  }
}

async function mergeDuplicatePeople(name: string) {
  const people = await db.person.findMany({
    where: { displayName: { equals: name, mode: "insensitive" } },
    include: { assignments: true, conversations: true },
    orderBy: { createdAt: "asc" },
  });
  if (people.length < 2) return;

  const [canonical, ...duplicates] = [...people].sort((a, b) => {
    const score = (person: typeof a) =>
      (person.active ? 1000 : 0) +
      (person.vscoExternalId ? 100 : 0) +
      person.assignments.length * 10 +
      person.conversations.length;
    return score(b) - score(a) || a.createdAt.getTime() - b.createdAt.getTime();
  });

  for (const duplicate of duplicates) {
    await db.$transaction(async tx => {
      for (const assignment of duplicate.assignments) {
        const existing = await tx.assignment.findUnique({
          where: {
            eventId_personId_role: {
              eventId: assignment.eventId,
              personId: canonical.id,
              role: assignment.role,
            },
          },
        });
        if (existing) {
          await tx.plannedAction.updateMany({ where: { assignmentId: assignment.id }, data: { assignmentId: existing.id, personId: canonical.id } });
          await tx.confirmationToken.updateMany({ where: { assignmentId: assignment.id }, data: { assignmentId: existing.id } });
          await tx.message.updateMany({ where: { assignmentId: assignment.id }, data: { assignmentId: existing.id, personId: canonical.id } });
          await tx.assignment.update({
            where: { id: existing.id },
            data: {
              active: existing.active || assignment.active,
              paused: existing.paused && assignment.paused,
              confirmationStatus: assignment.confirmationStatus === "CONFIRMED" ? "CONFIRMED" : existing.confirmationStatus,
              confirmedAt: existing.confirmedAt ?? assignment.confirmedAt,
            },
          });
          await tx.assignment.delete({ where: { id: assignment.id } });
        } else {
          await tx.assignment.update({ where: { id: assignment.id }, data: { personId: canonical.id } });
          await tx.plannedAction.updateMany({ where: { assignmentId: assignment.id }, data: { personId: canonical.id } });
          await tx.message.updateMany({ where: { assignmentId: assignment.id }, data: { personId: canonical.id } });
        }
      }

      for (const conversation of duplicate.conversations) {
        const existing = await tx.conversation.findUnique({
          where: { personId_channel: { personId: canonical.id, channel: conversation.channel } },
        });
        if (existing) {
          await tx.message.updateMany({ where: { conversationId: conversation.id }, data: { conversationId: existing.id, personId: canonical.id } });
          await tx.conversation.delete({ where: { id: conversation.id } });
        } else {
          await tx.conversation.update({ where: { id: conversation.id }, data: { personId: canonical.id } });
          await tx.message.updateMany({ where: { conversationId: conversation.id }, data: { personId: canonical.id } });
        }
      }

      await tx.message.updateMany({ where: { personId: duplicate.id }, data: { personId: canonical.id } });
      await tx.plannedAction.updateMany({ where: { personId: duplicate.id }, data: { personId: canonical.id } });
      await tx.person.update({
        where: { id: duplicate.id },
        data: { vscoExternalId: null, normalizedEmail: null, email: null, phone: null },
      });
      const currentCanonical = await tx.person.findUniqueOrThrow({ where: { id: canonical.id } });
      await tx.person.update({
        where: { id: canonical.id },
        data: {
          active: currentCanonical.active || duplicate.active,
          vscoExternalId: currentCanonical.vscoExternalId ?? duplicate.vscoExternalId,
          email: currentCanonical.email ?? duplicate.email,
          normalizedEmail: currentCanonical.normalizedEmail ?? duplicate.normalizedEmail,
          phone: currentCanonical.phone ?? duplicate.phone,
        },
      });
      await tx.person.delete({ where: { id: duplicate.id } });
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "DUPLICATE_PERSON_MERGED",
          entityType: "Person",
          entityId: canonical.id,
          before: { duplicateId: duplicate.id, duplicateName: duplicate.displayName },
          after: { canonicalId: canonical.id, canonicalName: canonical.displayName },
        },
      });
    });
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
