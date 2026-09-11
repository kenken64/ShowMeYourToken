import { timingSafeEqual } from "node:crypto";
import {
  consumeDailyAllowance,
  getQuotasByKey,
  setTokenLimit,
  setTokenLimitIfUnchanged,
} from "./dynamo";
import { invalidateQuotaCache } from "./quotaService";
import { getTeamInfo } from "./teamDirectory";
import { postToSlack } from "./slackClient";

/** Per-team daily increase allowance (rolling 24h), from env ADMIN_DAILY_LIMIT. */
export const DAILY_LIMIT = Number(process.env.ADMIN_DAILY_LIMIT ?? 2_000_000);
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

/** Validates body shape only (no cap checks — the daily allowance handles that). */
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

    if (typeof u.tokenLimit !== "number" || !Number.isInteger(u.tokenLimit) || u.tokenLimit < 0) {
      return { error: `updates[${i}].tokenLimit must be a non-negative integer (${label})`, attempted };
    }

    entries.push({ apiKeyId: u.apiKeyId, tokenLimit: u.tokenLimit });
  }

  return { entries };
}

interface PerKeyResult {
  apiKeyId: string;
  teamId: string | null;
  oldLimit: number;
  requestedLimit: number;
  status: "updated" | "exceeded" | "conflict";
  remainingAllowance?: number;
}

/** "f8jalog4ta TEAM-001 (Team Rocket)" — apiKeyId plus directory info when available. */
function label(r: PerKeyResult): string {
  const info = r.teamId ? getTeamInfo(r.teamId) : undefined;
  const parts = [r.apiKeyId];
  const names = [info?.teamCode, info?.teamName].filter((s): s is string => !!s);
  if (names.length > 0) parts.push(names.join(" — "));
  return parts.join(" ");
}

/** Handles PUT /api/admin/quota. Increases consume a per-team daily allowance (rolling 24h); decreases are free. */
export async function handleAdminQuotaUpdate(req: Request): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (!isAdminAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401); // deliberately not audited: attack noise
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

  const results: PerKeyResult[] = [];

  for (const entry of entries) {
    const row = existing.get(entry.apiKeyId)!;
    const oldLimit = row.tokenLimit;
    const increase = Math.max(0, entry.tokenLimit - oldLimit);

    // Decrease or no-op: free, no allowance consumed.
    if (increase === 0) {
      await setTokenLimit(entry.apiKeyId, entry.tokenLimit);
      results.push({
        apiKeyId: entry.apiKeyId,
        teamId: row.teamId,
        oldLimit,
        requestedLimit: entry.tokenLimit,
        status: "updated",
      });
      continue;
    }

    // Increase: consume from the daily allowance atomically.
    const allowance = await consumeDailyAllowance(entry.apiKeyId, increase, DAILY_LIMIT);
    if (!allowance) {
      results.push({
        apiKeyId: entry.apiKeyId,
        teamId: row.teamId,
        oldLimit,
        requestedLimit: entry.tokenLimit,
        status: "exceeded",
      });
      continue;
    }

    const written = await setTokenLimitIfUnchanged(entry.apiKeyId, entry.tokenLimit, oldLimit);
    if (!written) {
      // Row changed between read and write; refund is out of scope — surface as a conflict.
      results.push({
        apiKeyId: entry.apiKeyId,
        teamId: row.teamId,
        oldLimit,
        requestedLimit: entry.tokenLimit,
        status: "conflict",
      });
      continue;
    }

    results.push({
      apiKeyId: entry.apiKeyId,
      teamId: row.teamId,
      oldLimit,
      requestedLimit: entry.tokenLimit,
      status: "updated",
      remainingAllowance: allowance.remaining,
    });
  }

  invalidateQuotaCache();

  const updated = results.filter((r) => r.status === "updated");
  const blocked = results.filter((r) => r.status === "exceeded");
  const conflicts = results.filter((r) => r.status === "conflict");

  const lines: string[] = [];
  if (updated.length > 0) {
    lines.push(
      `✅ updated: ${updated.map((r) => `${label(r)} ${r.oldLimit.toLocaleString()}→${r.requestedLimit.toLocaleString()}${r.remainingAllowance !== undefined ? ` (allowance left ${r.remainingAllowance.toLocaleString()})` : ""}`).join(", ")}`
    );
  }
  if (blocked.length > 0) {
    lines.push(
      `⛔ blocked (daily allowance ${DAILY_LIMIT.toLocaleString()}): ${blocked.map((r) => `${label(r)} tried +${(r.requestedLimit - r.oldLimit).toLocaleString()}`).join(", ")}`
    );
  }
  if (conflicts.length > 0) {
    lines.push(`⚠️ conflict (row changed mid-update): ${conflicts.map((r) => label(r)).join(", ")}`);
  }
  await audit(`Admin quota update — ${lines.join(" | ")}`);

  // 200 if at least one updated and none blocked/conflicted; 207-style detail otherwise.
  const allOk = blocked.length === 0 && conflicts.length === 0;
  return json(
    {
      dailyLimit: DAILY_LIMIT,
      results,
      ...(allOk ? {} : { error: "Some updates were not applied (see results)" }),
    },
    allOk ? 200 : 422
  );
}
