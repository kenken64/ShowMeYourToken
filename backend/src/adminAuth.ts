import { timingSafeEqual } from "node:crypto";

export function isAdminAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
