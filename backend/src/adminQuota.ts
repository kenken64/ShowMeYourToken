import { timingSafeEqual } from "node:crypto";
import { getQuotasByKey, setTokenLimits } from "./dynamo";
import { invalidateQuotaCache } from "./quotaService";
import { postToSlack } from "./slackClient";

export const MAX_TOKEN_LIMIT = Number(process.env.ADMIN_MAX_TOKEN_LIMIT ?? 2_000_000);
const MAX_BATCH_SIZE = 100;

function isAdminAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function audit(text: string): Promise<void> {
  try {
    await postToSlack(text);
  } catch (err) {
    console.error("Slack audit post failed:", err);
  }
  console.log(`[admin audit] ${text}`);
}

interface UpdateEntry {
  apiKeyId: string;
  tokenLimit: number;
}

/** Validates request body shape + the per-update cap. Returns an error message or the parsed entries. */
function parseUpdates(body: unknown): { error: string; attempted: string } | { entries: UpdateEntry[] } {
  const attempted = Array.isArray((body as { updates?: unknown })?.updates)
    ? ((body as { updates: unknown[] }).updates
        .map((u) => `${(u as Partial<UpdateEntry>)?.apiKeyId ?? "?"}→${(u as Partial<UpdateEntry>)?.tokenLimit ?? "?"}`)
        .join(", "))
    : "(unparseable body)";

  if (typeof body !== "object" || body === null || !Array.isArray((body as { updates?: unknown }).updates)) {
    return { error: "Body must be JSON: { \"updates\": [{ \"apiKeyId\": string, \"tokenLimit\": number }, ...] }", attempted };
  }

  const updates = (body as { updates: unknown[] }).updates;
  if (updates.length === 0) return { error: "updates must not be empty", attempted };
  if (updates.length > MAX_BATCH_SIZE) return { error: `Too many updates in one request (max ${MAX_BATCH_SIZE})`, attempted };

  const entries: UpdateEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < updates.length; i++) {
    const u = updates[i] as Partial<UpdateEntry> | null;
    const label = u && typeof u.apiKeyId === "string" ? u.apiKeyId : `entry #${i + 1}`;

    if (!u || typeof u.apiKeyId !== "string" || u.apiKeyId.trim() === "") {
      return { error: `updates[${i}].apiKeyId must be a non-empty string`, attempted };
    }
    if (seen.has(u.apiKeyId)) return { error: `Duplicate apiKeyId in batch: ${u.apiKeyId}`, attempted };
    seen.add(u.apiKeyId);

    if (
      typeof u.tokenLimit !== "number" ||
      !Number.isInteger(u.tokenLimit) ||
      u.tokenLimit < 0
    ) {
      return { error: `updates[${i}].tokenLimit must be a non-negative integer (${label})`, attempted };
    }
    if (u.tokenLimit > MAX_TOKEN_LIMIT) {
      return { error: `tokenLimit for ${label} exceeds the max allowed per update (${MAX_TOKEN_LIMIT})`, attempted };
    }

    entries.push({ apiKeyId: u.apiKeyId, tokenLimit: u.tokenLimit });
  }

  return { entries };
}

function describe(entries: UpdateEntry[], oldLimits: Map<string, number>): string {
  return entries
    .map((e) => `${e.apiKeyId} ${oldLimits.get(e.apiKeyId) ?? "?"} → ${e.tokenLimit}`)
    .join(", ");
}

/** Handles PUT /api/admin/quota. Every validation outcome is audited to Slack. */
export async function handleAdminQuotaUpdate(req: Request): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (!isAdminAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401); // deliberately not audited: could be attack noise
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = parseUpdates(body);
  if ("error" in parsed) {
    await audit(`⚠️ Admin quota update REJECTED: ${parsed.error} (attempted: ${parsed.attempted})`);
    return json({ error: parsed.error }, 400);
  }

  const { entries } = parsed;
  const existing = await getQuotasByKey(entries.map((e) => e.apiKeyId));
  const missing = entries.filter((e) => !existing.has(e.apiKeyId)).map((e) => e.apiKeyId);
  if (missing.length > 0) {
    await audit(`⚠️ Admin quota update FAILED: unknown apiKeyId(s): ${missing.join(", ")}`);
    return json({ error: `Unknown apiKeyId(s): ${missing.join(", ")}` }, 404);
  }

  const oldLimits = new Map(entries.map((e) => [e.apiKeyId, existing.get(e.apiKeyId)!.tokenLimit]));

  await setTokenLimits(entries);
  invalidateQuotaCache();

  await audit(`✅ Admin quota update applied (${entries.length} team(s)): ${describe(entries, oldLimits)}`);

  return json({
    updated: entries.map((e) => ({
      apiKeyId: e.apiKeyId,
      teamId: existing.get(e.apiKeyId)!.teamId,
      oldLimit: oldLimits.get(e.apiKeyId),
      newLimit: e.tokenLimit,
    })),
  });
}
