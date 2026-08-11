import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { createWedgewoodContact, removeWedgewoodContact, updateWedgewoodContact } from "@/services/wedgewood-contacts";
import styles from "./page.module.css";

async function saveContact(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  const input = {
    venueName: String(data.get("venueName") ?? ""),
    contactName: String(data.get("contactName") ?? ""),
    teamOrRole: String(data.get("teamOrRole") ?? ""),
    email: String(data.get("email") ?? ""),
  };
  const nonce = String(data.get("nonce") || randomUUID());
  const contactId = String(data.get("contactId") ?? "");
  if (contactId) await updateWedgewoodContact(admin.id, contactId, input, nonce);
  else await createWedgewoodContact(admin.id, input, nonce);
  revalidatePath("/wedgewood-contacts");
}

async function removeContact(data: FormData) {
  "use server";
  const admin = await requireAdmin();
  await removeWedgewoodContact(admin.id, String(data.get("contactId")), String(data.get("removeNonce") || randomUUID()));
  revalidatePath("/wedgewood-contacts");
}

export default async function Page() {
  await requireAdmin();
  const contacts = await db.wedgewoodContact.findMany({ where: { active: true }, orderBy: [{ venueName: "asc" }, { contactName: "asc" }, { email: "asc" }] });
  const venues = new Set(contacts.map(contact => contact.venueName)).size;
  return <>
    <h1>Wedgewood Contacts</h1>
    <p className="muted">One editable directory for every Wedgewood venue and team email. VSCO contacts are added during sync; your edits are preserved.</p>
    <section className="grid">
      <div className="card"><div className="muted">Venues and teams</div><div className="metric">{venues}</div></div>
      <div className="card"><div className="muted">Active email contacts</div><div className="metric">{contacts.length}</div></div>
    </section>
    <h2>Add a contact</h2>
    <form action={saveContact} className={`card ${styles.editor}`}>
      <input type="hidden" name="nonce" value={`create:${randomUUID()}`} />
      <input name="venueName" required placeholder="Venue or team" />
      <input name="contactName" placeholder="Contact name" />
      <input name="teamOrRole" placeholder="Team or role" />
      <input name="email" type="email" required placeholder="name@example.com" />
      <button>Add contact</button>
    </form>
    <h2>Directory</h2>
    {!contacts.length && <div className="card muted">No Wedgewood contacts have been found yet. Add one here, or run a VSCO sync to import matching address-book contacts.</div>}
    <div className={styles.directory}>
      {contacts.map(contact => <form action={saveContact} className={`card ${styles.editor}`} key={contact.id}>
        <input type="hidden" name="nonce" value={`update:${contact.id}:${randomUUID()}`} />
        <input type="hidden" name="contactId" value={contact.id} />
        <label>Venue or team<input name="venueName" required defaultValue={contact.venueName} /></label>
        <label>Contact name<input name="contactName" defaultValue={contact.contactName ?? ""} /></label>
        <label>Team or role<input name="teamOrRole" defaultValue={contact.teamOrRole ?? ""} /></label>
        <label>Email<input name="email" type="email" required defaultValue={contact.email} /></label>
        <div className={styles.actions}>
          <button>Save</button>
          <button className="secondary" formAction={removeContact} name="contactId" value={contact.id}>Remove</button>
          <input type="hidden" name="removeNonce" value={`remove:${contact.id}:${randomUUID()}`} />
        </div>
      </form>)}
    </div>
  </>;
}
