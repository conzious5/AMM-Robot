import { z } from "zod";
import { env } from "@/lib/env";

const Assignment = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  role: z.string(),
  teamMember: z.object({
    id: z.union([z.string(), z.number()]).transform(String).optional(),
    firstName: z.string().default(""),
    lastName: z.string().default(""),
    name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
});
const Event = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  jobId: z.union([z.string(), z.number()]).transform(String).optional(),
  name: z.string(),
  type: z.string().default("Wedding"),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().optional(),
  venue: z.object({ name: z.string().optional(), address: z.string().optional() }).optional(),
  status: z.string().optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  assignments: z.array(Assignment).optional(),
}).passthrough();
export type NormalizedVscoEvent = {
  externalId: string; jobId?: string; name: string; eventType: string; startsAt: Date; endsAt?: Date;
  timezone: string; venueName?: string; address?: string; canceled: boolean; assignments: z.infer<typeof Assignment>[] | null; raw: unknown;
};
export type VscoTimelineFile = {
  id: string;
  url: string;
  mimeType?: string;
  modified?: string;
};
export const isProductionAssignment = (assignment: z.infer<typeof Assignment>) =>
  /\b(photo(?:grapher|graphy)?|video(?:grapher|graphy)?)\b/i.test(assignment.role);
export const isTimelineFile = (file: {
  name?: string | null;
  filename?: string | null;
  description?: string | null;
  mimeType?: string | null;
  url?: string | null;
}) => {
  const label = [file.name, file.filename, file.description].filter(Boolean).join(" ");
  const matchesTimeline = /\btimeline\b|\b(?:job[\s_-]*)?day[\s_-]*sheet\b/i.test(label);
  const allowedMimeTypes = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]);
  return matchesTimeline && Boolean(file.url) && Boolean(file.mimeType && allowedMimeTypes.has(file.mimeType));
};

export function normalizeVscoEvent(input: unknown): NormalizedVscoEvent {
  const value = Event.parse(input);
  return {
    externalId: value.id, jobId: value.jobId, name: value.name, eventType: value.type,
    startsAt: new Date(value.start), endsAt: value.end ? new Date(value.end) : undefined,
    timezone: value.timezone ?? env().DEFAULT_TIMEZONE, venueName: value.venue?.name, address: value.venue?.address,
    canceled: ["canceled", "cancelled"].includes(value.status?.toLowerCase() ?? ""),
    assignments: value.assignments ?? null, raw: input,
  };
}

export class VscoWorkspaceProvider {
  private readonly contacts = new Map<string, z.infer<typeof OfficialContact>>();
  private readonly roles = new Map<string, z.infer<typeof OfficialJobRole>>();
  private readonly jobContacts = new Map<string, z.infer<typeof OfficialJobContact>[]>();
  private readonly ceremonyJobs = new Set<string>();
  private assignmentsLoaded = false;

  async *events(params: { from: Date; to: Date; cursor?: string }) {
    const cfg = env();
    if (!cfg.VSCO_API_KEY) throw new Error("VSCO_API_KEY is not configured");
    if (!cfg.VSCO_EVENTS_PATH) throw new Error("VSCO_EVENTS_PATH must be set to the events endpoint shown in the authenticated VSCO V2 documentation; this project intentionally does not guess private endpoint names.");
    let page = Number(params.cursor ?? 1);
    let totalPages = 1;
    do {
      const url = this.url(cfg.VSCO_EVENTS_PATH);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("includeHidden", "false");
      url.searchParams.set("sortBy", "modified asc");
      const body = Collection.parse(await (await this.request(url)).json());
      const normalized: NormalizedVscoEvent[] = [];
      for (const input of body.items) {
        const event = OfficialEvent.parse(input);
        if (!event.name?.trim().toLowerCase().includes("ceremony")) continue;
        if (event.jobId && this.ceremonyJobs.has(event.jobId)) continue;
        if (!event.startUtc) continue;
        const startsAt = new Date(event.startUtc);
        if (startsAt < params.from || startsAt > params.to) continue;
        const assignments = event.jobId
          ? (await this.assignments(event.jobId)).filter(isProductionAssignment)
          : [];
        // A ceremony calendar item is a booked gig for this system only when
        // VSCO has assigned a photographer or videographer to its job.
        if (!assignments.length) continue;
        if (event.jobId) this.ceremonyJobs.add(event.jobId);
        const address = event.location?.address;
        normalized.push({
          externalId: event.id,
          jobId: event.jobId ?? undefined,
          name: event.name || "Untitled event",
          eventType: "Wedding",
          startsAt,
          endsAt: event.endUtc ? new Date(event.endUtc) : undefined,
          timezone: event.timezoneName || address?.timezone || cfg.DEFAULT_TIMEZONE,
          venueName: address?.name ?? undefined,
          address: address ? [address.streetAddress, address.city, address.state, address.postalCode].filter(Boolean).join(", ") : undefined,
          canceled: event.hidden,
          assignments,
          raw: input,
        });
      }
      totalPages = body.meta?.totalPages ?? page;
      yield { events: normalized, cursor: page < totalPages ? String(page + 1) : undefined };
      page++;
    } while (page <= totalPages);
  }

  async timelineFiles(jobId: string): Promise<VscoTimelineFile[]> {
    const files = await this.collection("/file", { jobId });
    const matchingFiles: z.infer<typeof OfficialFile>[] = [];
    for (const input of files.items) {
      const parsed = OfficialFile.safeParse(input);
      if (parsed.success && isTimelineFile(parsed.data)) matchingFiles.push(parsed.data);
    }
    return matchingFiles
      .sort((a, b) => modifiedTime(b.modified) - modifiedTime(a.modified))
      .filter((file, index, all) => all.findIndex(candidate => candidate.url === file.url) === index)
      .slice(0, 1)
      .map(file => ({
        id: file.id,
        url: file.url!,
        mimeType: file.mimeType ?? undefined,
        modified: file.modified ?? undefined,
      }));
  }

  private async assignments(jobId: string) {
    await this.loadAssignmentData();
    const assignments: z.infer<typeof Assignment>[] = [];
    for (const link of this.jobContacts.get(jobId) ?? []) {
      if (!link.roleKinds.includes("team")) continue;
      const contact = this.contacts.get(link.contactId);
      if (!contact) continue;
      for (const roleId of link.jobRoles) {
        if (!roleId) continue;
        const role = this.roles.get(roleId);
        if (!role) continue;
        if (role.kind !== "team") continue;
        assignments.push({
          id: `${link.id}:${role.id}`,
          role: role.name,
          teamMember: {
            id: contact.id,
            firstName: contact.firstName ?? "",
            lastName: contact.lastName ?? "",
            name: contact.name ?? undefined,
            email: contact.email ?? undefined,
            phone: contact.cellPhone?.e164 ?? contact.cellPhone?.formatted ?? undefined,
          },
        });
      }
    }
    return assignments;
  }

  private async loadAssignmentData() {
    if (this.assignmentsLoaded) return;
    const [links, contacts, roles] = await Promise.all([
      this.collection("/job-contact"),
      this.collection("/address-book"),
      this.collection("/job-role"),
    ]);
    for (const input of contacts.items) {
      const parsed = OfficialContact.safeParse(input);
      if (parsed.success) this.contacts.set(parsed.data.id, parsed.data);
    }
    for (const input of roles.items) {
      const parsed = OfficialJobRole.safeParse(input);
      if (parsed.success) this.roles.set(parsed.data.id, parsed.data);
    }
    for (const input of links.items) {
      const parsed = OfficialJobContact.safeParse(input);
      if (!parsed.success) continue;
      const group = this.jobContacts.get(parsed.data.jobId) ?? [];
      group.push(parsed.data);
      this.jobContacts.set(parsed.data.jobId, group);
    }
    this.assignmentsLoaded = true;
  }

  private async collection(path: string, params: Record<string, string> = {}) {
    const all: unknown[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const url = this.url(path);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", "100");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const body = Collection.parse(await (await this.request(url)).json());
      all.push(...body.items);
      totalPages = body.meta?.totalPages ?? page;
      page++;
    } while (page <= totalPages);
    return { items: all };
  }

  private url(path: string) {
    return new URL(path.replace(/^\//, ""), `${env().VSCO_API_BASE_URL.replace(/\/?$/, "/")}`);
  }

  private async request(url: URL) {
    let error: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(url, { headers: { "X-API-KEY": env().VSCO_API_KEY ?? "", Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (response.ok) return response;
      if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`VSCO request failed (${response.status})`);
      error = new Error(`Temporary VSCO failure (${response.status})`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(1000 * 2 ** attempt, 15000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw error;
  }
}

const Collection = z.object({
  meta: z.object({
    currentPage: z.number().optional(),
    totalPages: z.number().optional(),
    totalItems: z.number().optional(),
    rows: z.number().optional(),
  }).optional(),
  items: z.array(z.unknown()),
}).passthrough();

const Address = z.object({
  name: z.string().nullable().optional(),
  streetAddress: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
}).passthrough();

const OfficialEvent = z.object({
  id: z.string(),
  modified: z.string().optional(),
  hidden: z.boolean().default(false),
  jobId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  startUtc: z.string().datetime({ offset: true }).nullable().optional(),
  endUtc: z.string().datetime({ offset: true }).nullable().optional(),
  timezoneName: z.string().nullable().optional(),
  location: z.object({ address: Address.nullable().optional() }).nullable().optional(),
}).passthrough();

const OfficialJobContact = z.object({
  id: z.string(),
  contactId: z.string(),
  jobId: z.string(),
  jobRoles: z.array(z.string().nullable()).nullable().default([]).transform(value => value ?? []),
  roleKinds: z.array(z.string()).default([]),
}).passthrough();

const OfficialContact = z.object({
  id: z.string(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  cellPhone: z.object({
    e164: z.string().nullable().optional(),
    formatted: z.string().nullable().optional(),
  }).nullable().optional(),
}).passthrough();

const OfficialJobRole = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string().nullable().optional(),
}).passthrough();

const OfficialFile = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  filename: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  modified: z.string().nullable().optional(),
}).passthrough();

const modifiedTime = (value?: string | null) => {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
};
