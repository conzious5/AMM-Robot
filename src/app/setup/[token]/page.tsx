import { notFound, redirect } from "next/navigation";
import { completeAdministratorInvite, getAdministratorInvite } from "@/lib/admin-invite";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const invite = await getAdministratorInvite(token);
  if (!invite) notFound();

  async function setPassword(data: FormData) {
    "use server";
    const password = String(data.get("password") || "");
    const confirmation = String(data.get("confirmation") || "");
    let message = "";
    if (password !== confirmation) message = "The passwords do not match.";
    else {
      try {
        await completeAdministratorInvite(token, password);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : "Account setup failed.";
      }
    }
    if (message) redirect(`/setup/${token}?error=${encodeURIComponent(message)}`);
    redirect("/login?setup=1");
  }

  return (
    <main className="login card">
      <h1>Set up AMM Robot</h1>
      <p><b>{invite.administrator.name}</b></p>
      <p className="muted">{invite.administrator.email} · Project manager</p>
      {error && <p className="danger">{error}</p>}
      <form action={setPassword}>
        <label>New password</label>
        <input name="password" type="password" minLength={12} autoComplete="new-password" required />
        <label>Confirm password</label>
        <input name="confirmation" type="password" minLength={12} autoComplete="new-password" required />
        <p><button>Activate my account</button></p>
      </form>
      <p className="muted">Use at least 12 characters. This one-time link expires {invite.expiresAt.toLocaleString()}.</p>
    </main>
  );
}
