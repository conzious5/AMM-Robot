export const ADMINISTRATOR_EMAIL = "hello@authentic-moments.com";
export const PORTAL_USER_EMAIL = "cylina@authentic-moments.com";

export function isAuthorizedHumanAccount<T extends { email: string; role: string; active: boolean }>(account: T | null): account is T {
  if (!account?.active) return false;
  const email = account.email.trim().toLowerCase();
  return (email === ADMINISTRATOR_EMAIL && account.role === "ADMIN")
    || (email === PORTAL_USER_EMAIL && account.role === "PROJECT_MANAGER");
}
