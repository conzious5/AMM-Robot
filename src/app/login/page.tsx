import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
export default function Login() {
  async function login(data: FormData) { "use server"; if (await signIn(String(data.get("email")), String(data.get("password")))) redirect("/"); redirect("/login?error=1"); }
  return <main className="login card"><h1>Authentic Moments</h1><p className="muted">Scheduling operations</p><form action={login}><label>Email</label><input name="email" type="email" required/><label>Password</label><input name="password" type="password" required/><p><button>Sign in</button></p></form></main>;
}
