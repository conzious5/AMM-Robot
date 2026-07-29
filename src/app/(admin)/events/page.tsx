import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/lib/db";
import { DataTable } from "@/components/DataTable";

const PAGE_SIZE = 25;
const productionRoles = ["PHOTOGRAPHER", "VIDEOGRAPHER"] as const;
type View = "upcoming" | "past" | "all";

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function href(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const value = query.toString();
  return value ? `/events?${value}` : "/events";
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const requestedView = one(query.view);
  const view: View = requestedView === "past" || requestedView === "all" ? requestedView : "upcoming";
  const search = one(query.q)?.trim() ?? "";
  const date = one(query.date) ?? "";
  const year = one(query.year) ?? "";
  const requestedPage = Number(one(query.page) ?? 1);
  const now = new Date();

  const data = await db.event.findMany({
    where: {
      canceled: false,
      assignments: {
        some: {
          active: true,
          role: { in: [...productionRoles] },
          person: { active: true },
        },
      },
    },
    include: {
      assignments: {
        where: {
          active: true,
          role: { in: [...productionRoles] },
          person: { active: true },
        },
        include: { person: true },
      },
    },
    orderBy: { startsAt: "asc" },
  });

  const eventDate = (event: (typeof data)[number]) =>
    formatInTimeZone(event.startsAt, event.timezone, "yyyy-MM-dd");
  const eventYear = (event: (typeof data)[number]) =>
    formatInTimeZone(event.startsAt, event.timezone, "yyyy");

  const years = [...new Set(data.map(eventYear))].sort();
  const searchKey = search.toLowerCase();
  const filtered = data.filter(event => {
    if (view === "upcoming" && event.startsAt < now) return false;
    if (view === "past" && event.startsAt >= now) return false;
    if (date && eventDate(event) !== date) return false;
    if (year && eventYear(event) !== year) return false;
    if (searchKey) {
      const haystack = [
        event.name,
        event.venueName,
        event.address,
        ...event.assignments.map(assignment => assignment.person.displayName),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(searchKey)) return false;
    }
    return true;
  });

  if (view === "past") filtered.reverse();
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1), pageCount);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const linkState = { view, q: search || undefined, date: date || undefined, year: year || undefined };

  return (
    <>
      <h1>Events</h1>
      <p className="muted">Booked VSCO ceremony gigs with an assigned photographer or videographer.</p>

      <form className="filters" method="get">
        <label>
          View
          <select name="view" defaultValue={view}>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Year
          <select name="year" defaultValue={year}>
            <option value="">All years</option>
            {years.map(value => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <label>
          Exact date
          <input type="date" name="date" defaultValue={date} />
        </label>
        <label className="filter-search">
          Search
          <input name="q" defaultValue={search} placeholder="Event, venue, or contractor" />
        </label>
        <button type="submit">Apply filters</button>
        <Link className="button secondary" href="/events">Clear</Link>
      </form>

      <div className="year-nav" aria-label="Year navigation">
        <Link className="button secondary" href={href({ ...linkState, year: year ? Number(year) - 1 : String(now.getFullYear() - 1), page: 1 })}>‹ Previous year</Link>
        <span><b>{filtered.length}</b> matching booked {filtered.length === 1 ? "gig" : "gigs"}</span>
        <Link className="button secondary" href={href({ ...linkState, year: year ? Number(year) + 1 : String(now.getFullYear() + 1), page: 1 })}>Next year ›</Link>
      </div>

      {visible.length ? (
        <DataTable
          columns={["Event", "Date / venue", "Assignments", "Sync"]}
          rows={visible.map(event => [
            <b key="name">{event.name}</b>,
            <span key="date">
              {formatInTimeZone(event.startsAt, event.timezone, "MMM d, yyyy · h:mm a zzz")}
              <br />
              <span className="muted">{event.venueName ?? "Venue pending"}</span>
            </span>,
            <span key="assignments">
              {event.assignments.map(assignment => (
                <span key={assignment.id}>
                  {assignment.person.displayName} · {assignment.role.toLowerCase()} · <span className="pill">{assignment.confirmationStatus}</span>
                  <br />
                </span>
              ))}
            </span>,
            <span key="sync">
              {event.lastSyncedAt?.toLocaleString() ?? "Manual"}
              <br />
              <span className="muted">{event.vscoJobId ? `Job ${event.vscoJobId}` : event.vscoEventId ?? "No VSCO ID"}</span>
            </span>,
          ])}
        />
      ) : (
        <div className="card">No booked ceremony gigs match these filters.</div>
      )}

      <div className="pager" aria-label="Event pages">
        {page > 1
          ? <Link className="button secondary" href={href({ ...linkState, page: page - 1 })}>‹ Previous</Link>
          : <span />}
        <span>Page {page} of {pageCount}</span>
        {page < pageCount
          ? <Link className="button" href={href({ ...linkState, page: page + 1 })}>Next ››</Link>
          : <span />}
      </div>
    </>
  );
}
