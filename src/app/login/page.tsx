import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; setup?: string }> }) {
  const params = await searchParams;
  async function login(data: FormData) { "use server"; if (await signIn(String(data.get("email")), String(data.get("password")))) redirect("/"); redirect("/login?error=1"); }
  return <main className="login card"><h1>Authentic Moments</h1><p className="muted">Scheduling operations</p>{params.setup === "1" && <p className="ready">Your account is active. Sign in with your new password.</p>}{params.error && <p className="danger">The email or password was not recognized.</p>}<form action={login}><label>Email</label><input name="email" type="email" autoComplete="username" maxLength={254} required/><label>Password</label><input name="password" type="password" autoComplete="current-password" maxLength={256} required/><p><button>Sign in</button></p></form></main>;
}
