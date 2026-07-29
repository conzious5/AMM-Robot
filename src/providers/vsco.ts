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
  async *events(params: { from: Date; to: Date; cursor?: string }) {
    const cfg = env();
    if (!cfg.VSCO_API_KEY) throw new Error("VSCO_API_KEY is not configured");
    if (!cfg.VSCO_EVENTS_PATH) throw new Error("VSCO_EVENTS_PATH must be set to the events endpoint shown in the authenticated VSCO V2 documentation; this project intentionally does not guess private endpoint names.");
    let next: string | undefined = cfg.VSCO_EVENTS_PATH;
    let cursor = params.cursor;
    while (next) {
      const url = new URL(next, `${cfg.VSCO_API_BASE_URL}/`);
      url.searchParams.set("start", params.from.toISOString());
      url.searchParams.set("end", params.to.toISOString());
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await this.request(url);
      const body = z.object({ data: z.array(z.unknown()), next: z.string().optional(), cursor: z.string().optional() }).passthrough().parse(await response.json());
      yield { events: body.data.map(normalizeVscoEvent), cursor: body.cursor };
      next = body.next;
      cursor = undefined;
    }
  }
  private async request(url: URL) {
    let error: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${env().VSCO_API_KEY}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (response.ok) return response;
      if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`VSCO request failed (${response.status})`);
      error = new Error(`Temporary VSCO failure (${response.status})`);
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
    }
    throw error;
  }
}
