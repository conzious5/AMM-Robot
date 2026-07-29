import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sendReminderPreview } from "@/services/messaging";
import { runVscoSync } from "@/services/sync";

async function update(data: FormData) {
  "use server";
  const id = String(data.get("id"));
  await db.reminderPolicy.update({ where: { id }, data: { active: data.get("enabled") === "on" } });
  revalidatePath("/settings");
}

async function sync() {
  "use server";
  await runVscoSync();
  revalidatePath("/settings");
}

async function sendTest(data: FormData) {
  "use server";
  const channel = String(data.get("channel")) === "EMAIL" ? "EMAIL" : "SMS";
  let result = `${channel.toLowerCase()}-sent`;
  try {
    await sendReminderPreview(channel);
  } catch (error) {
    result = error instanceof Error ? error.message : "Test send failed";
  }
  redirect(`/settings?test=${encodeURIComponent(result)}`);
}

export default async function Page({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const { test } = await searchParams;
  const config = env();
  const policies = await db.reminderPolicy.findMany({ orderBy: { attemptNumber: "asc" } });
  const syncRun = await db.syncRun.findFirst({ orderBy: { startedAt: "desc" } });
  const testReady = Boolean(
    config.TEST_MODE &&
    config.RESEND_API_KEY &&
    config.TEST_EMAIL_RECIPIENT &&
    config.QUO_API_KEY &&
    config.QUO_PHONE_NUMBER &&
    config.TEST_SMS_RECIPIENT
  );

  return (
    <>
      <h1>Settings</h1>
      <section className="grid">
        <div className="card">
          <h3>Safety</h3>
          <p>Test mode: <b>{String(config.TEST_MODE)}</b></p>
          <p>Global environment pause: <b>{String(config.GLOBAL_COMMUNICATIONS_PAUSED)}</b></p>
          <p className="muted">Production mode requires changing Railway variables and redeploying.</p>
        </div>
        <div className="card">
          <h3>VSCO</h3>
          <p>Last sync: {syncRun?.startedAt.toLocaleString() ?? "Never"}</p>
          <p>Status: {syncRun?.status ?? "Not configured"}</p>
          <form action={sync}><button>Run sync now</button></form>
        </div>
        <div className="card">
          <h3>Reminder test</h3>
          <p>Email and SMS test configuration: <b>{testReady ? "Ready" : "Incomplete"}</b></p>
          {test === "email-sent" && <p>Test email accepted by Resend.</p>}
          {test === "sms-sent" && <p>Test text accepted by Quo.</p>}
          {test && !["email-sent", "sms-sent"].includes(test) && <p className="danger">{test}</p>}
          <form action={sendTest}>
            <button name="channel" value="EMAIL" disabled={!testReady}>Send test email</button>{" "}
            <button name="channel" value="SMS" disabled={!testReady}>Send test text</button>
          </form>
        </div>
      </section>
      <h2>Reminder policies</h2>
      {policies.map(policy => (
        <form action={update} className="card" key={policy.id}>
          <input type="hidden" name="id" value={policy.id} />
          <b>{policy.name}</b>
          <p>{policy.offsetMinutes / 1440} days before · {policy.channel} · attempt {policy.attemptNumber}</p>
          <label>
            <input style={{ width: "auto" }} type="checkbox" name="enabled" defaultChecked={policy.active} /> Enabled
          </label>{" "}
          <button>Save</button>
        </form>
      ))}
    </>
  );
}
