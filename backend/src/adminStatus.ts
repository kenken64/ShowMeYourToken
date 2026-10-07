import { isAdminAuthorized } from "./adminAuth";
import { getQuotasByKey, setTeamStatus, type TeamUsageStatus } from "./dynamo";
import { invalidateQuotaCache } from "./quotaService";
import { getTeamInfo } from "./teamDirectory";
import { postToSlack } from "./slackClient";

const MAX_BATCH_SIZE = 500;

interface StatusUpdate {
  apiKeyId: string;
  status: TeamUsageStatus;
}

interface StatusResult {
  apiKeyId: string;
  teamId: string | null;
  oldStatus: string | null;
  newStatus: TeamUsageStatus;
  status: "updated" | "failed";
}

function parseUpdates(body: unknown): { entries: StatusUpdate[] } | { error: string } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { updates?: unknown }).updates)) {
    return { error: 'Body must be JSON: { "updates": [{ "apiKeyId": string, "status": "ACTIVE" | "DISABLED" }, ...] }' };
  }
  const updates = (body as { updates: unknown[] }).updates;
  if (updates.length === 0) return { error: "updates must not be empty" };
  if (updates.length > MAX_BATCH_SIZE) return { error: `Too many updates in one request (max ${MAX_BATCH_SIZE})` };
  const entries: StatusUpdate[] = [];
  const seen = new Set<string>();
  for (const [index, value] of updates.entries()) {
    if (!value || typeof value !== "object") return { error: `updates[${index}] must be an object` };
    const update = value as Partial<StatusUpdate>;
    if (typeof update.apiKeyId !== "string" || !update.apiKeyId.trim()) {
      return { error: `updates[${index}].apiKeyId must be a non-empty string` };
    }
    if (seen.has(update.apiKeyId)) return { error: `Duplicate apiKeyId in batch: ${update.apiKeyId}` };
    if (update.status !== "ACTIVE" && update.status !== "DISABLED") {
      return { error: `updates[${index}].status must be ACTIVE or DISABLED` };
    }
    seen.add(update.apiKeyId);
    entries.push({ apiKeyId: update.apiKeyId, status: update.status });
  }
  return { entries };
}

/** Single-team and bulk access updates use the same admin authentication as quota updates. */
export async function handleAdminStatusUpdate(req: Request): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  if (!isAdminAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseUpdates(body);
  if ("error" in parsed) return json({ error: parsed.error }, 400);

  let existing;
  try {
    existing = await getQuotasByKey(parsed.entries.map((entry) => entry.apiKeyId));
  } catch (err) {
    console.error("Admin status lookup failed:", err);
    return json({ error: "Failed to read team records; no usage changes were applied" }, 503);
  }
  const missing = parsed.entries.filter((entry) => !existing.has(entry.apiKeyId));
  if (missing.length > 0) {
    return json({ error: `Unknown apiKeyId(s): ${missing.map((entry) => entry.apiKeyId).join(", ")}` }, 404);
  }

  const results: StatusResult[] = [];
  for (const entry of parsed.entries) {
    const row = existing.get(entry.apiKeyId)!;
    try {
      const oldStatus = await setTeamStatus(entry.apiKeyId, entry.status);
      results.push({ apiKeyId: entry.apiKeyId, teamId: row.teamId, oldStatus, newStatus: entry.status, status: "updated" });
    } catch (err) {
      console.error(`Admin status update failed for ${entry.apiKeyId}:`, err);
      results.push({ apiKeyId: entry.apiKeyId, teamId: row.teamId, oldStatus: row.status, newStatus: entry.status, status: "failed" });
    }
  }
  invalidateQuotaCache();

  const details = results.map((result) => {
    const info = result.teamId ? getTeamInfo(result.teamId) : undefined;
    const team = [result.apiKeyId, info?.teamCode, info?.teamName].filter(Boolean).join(" — ");
    return `${result.status}: ${team} ${result.oldStatus ?? "unset"}→${result.newStatus}`;
  }).join(", ");
  const message = `Admin team usage update — ${details}`;
  console.log(`[admin audit] ${message}`);
  try {
    await postToSlack(message);
  } catch (err) {
    console.error("Slack status audit post failed:", err);
  }

  const allOk = results.every((result) => result.status === "updated");
  return json({ results, ...(allOk ? {} : { error: "Some usage changes were not applied (see results)" }) }, allOk ? 200 : 422);
}
