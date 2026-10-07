import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { BatchGetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// Tests replace every DynamoDB operation and disable Slack before importing app modules.
process.env.AWS_REGION = "ap-southeast-1";
process.env.AWS_ACCESS_KEY_ID = "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.SLACK_WEBHOOK_URL = "";

const { ddb, TABLE_NAME, getQuotasByKey, setTeamStatus } = await import("./dynamo");
const { handleAdminStatusUpdate } = await import("./adminStatus");
const { getEnrichedQuota, invalidateQuotaCache } = await import("./quotaService");

type Team = {
  apiKeyId: string;
  teamId: string;
  status: string;
  tokenLimit: number;
  usedTokens: number;
  reservedTokens: number;
};

let teams: Map<string, Team>;
let failKey: string | null;
const send = spyOn(ddb, "send");
const warn = spyOn(console, "warn").mockImplementation(() => {});
const log = spyOn(console, "log").mockImplementation(() => {});
const error = spyOn(console, "error").mockImplementation(() => {});

function request(updates: unknown, authorization: string | null = "Bearer test-admin-token") {
  return new Request("http://localhost/api/admin/status", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ updates }),
  });
}

function seed(apiKeyId: string, status = "ACTIVE"): Team {
  return { apiKeyId, teamId: `team-${apiKeyId}`, status, tokenLimit: 6_000_000, usedTokens: 1234, reservedTokens: 256 };
}

beforeEach(() => {
  process.env.ADMIN_TOKEN = "test-admin-token";
  teams = new Map([["a", seed("a")], ["b", seed("b", "DISABLED")]]);
  failKey = null;
  invalidateQuotaCache();
  send.mockClear();
  send.mockImplementation(async (command) => {
    if (command instanceof BatchGetCommand) {
      const keys = command.input.RequestItems?.[TABLE_NAME]?.Keys ?? [];
      return { $metadata: {}, Responses: { [TABLE_NAME]: keys.flatMap((key) => {
        const team = teams.get(String(key.apiKeyId));
        return team ? [{ ...team }] : [];
      }) } };
    }
    if (command instanceof UpdateCommand) {
      const apiKeyId = String(command.input.Key?.apiKeyId);
      if (apiKeyId === failKey) throw new Error("Simulated write failure");
      const team = teams.get(apiKeyId);
      if (!team) throw new Error("ConditionalCheckFailedException");
      const old = { ...team };
      team.status = String(command.input.ExpressionAttributeValues?.[":status"]);
      return { $metadata: {}, Attributes: old };
    }
    if (command instanceof ScanCommand) return { $metadata: {}, Items: [...teams.values()].map((team) => ({ ...team })) };
    throw new Error("Unexpected DynamoDB operation in status tests");
  });
});

afterAll(() => {
  send.mockRestore();
  warn.mockRestore();
  log.mockRestore();
  error.mockRestore();
});

describe("admin team usage updates", () => {
  it("requires the admin token before reading or writing DynamoDB", async () => {
    for (const authorization of [null, "Bearer incorrect", "Basic test-admin-token"]) {
      const response = await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }], authorization));
      expect(response.status).toBe(401);
    }
    delete process.env.ADMIN_TOKEN;
    expect((await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }]))).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const response = await handleAdminStatusUpdate(new Request("http://localhost/api/admin/status", {
      method: "PUT", headers: { Authorization: "Bearer test-admin-token" }, body: "{invalid",
    }));
    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("validates the complete batch before writing", async () => {
    const invalid = [undefined, [], [null], ["a"], [{ apiKeyId: "", status: "ACTIVE" }],
      [{ apiKeyId: "a", status: "ACTIVE" }, { apiKeyId: "b", status: "ENABLED" }],
      [{ apiKeyId: "a", status: "ACTIVE" }, { apiKeyId: "a", status: "DISABLED" }],
      Array.from({ length: 501 }, (_, i) => ({ apiKeyId: String(i), status: "ACTIVE" }))];
    for (const updates of invalid) expect((await handleAdminStatusUpdate(request(updates))).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a batch containing an unknown key without applying other updates", async () => {
    const response = await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }, { apiKeyId: "missing", status: "ACTIVE" }]));
    expect(response.status).toBe(404);
    expect(teams.get("a")?.status).toBe("ACTIVE");
    expect(send.mock.calls.every(([command]) => command instanceof BatchGetCommand)).toBe(true);
  });

  it("enables and disables teams while preserving token counters and allowance", async () => {
    const before = [...teams.values()].map((team) => ({ ...team }));
    const response = await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }, { apiKeyId: "b", status: "ACTIVE" }]));
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Record<string, unknown>[] };
    expect(body.results).toEqual([
      { apiKeyId: "a", teamId: "team-a", oldStatus: "ACTIVE", newStatus: "DISABLED", status: "updated" },
      { apiKeyId: "b", teamId: "team-b", oldStatus: "DISABLED", newStatus: "ACTIVE", status: "updated" },
    ]);
    expect(teams.get("a")).toEqual({ ...before[0]!, status: "DISABLED" });
    expect(teams.get("b")).toEqual({ ...before[1]!, status: "ACTIVE" });
    const writes = send.mock.calls.map(([command]) => command).filter((command) => command instanceof UpdateCommand);
    expect(writes).toHaveLength(2);
    for (const command of writes) {
      expect(command.input.TableName).toBe(TABLE_NAME);
      expect(command.input.UpdateExpression).toBe("SET #status = :status");
      expect(command.input.ConditionExpression).toBe("attribute_exists(apiKeyId)");
    }
    expect(send.mock.calls.every(([command]) => command instanceof BatchGetCommand || command instanceof UpdateCommand)).toBe(true);
  });

  it("supports all 118 teams across DynamoDB's 100-key batch read limit", async () => {
    teams = new Map(Array.from({ length: 118 }, (_, i) => [String(i), seed(String(i))]));
    const response = await handleAdminStatusUpdate(request([...teams.keys()].map((apiKeyId) => ({ apiKeyId, status: "DISABLED" }))));
    expect(response.status).toBe(200);
    expect((await response.json() as { results: unknown[] }).results).toHaveLength(118);
    expect([...teams.values()].every((team) => team.status === "DISABLED")).toBe(true);
    const reads = send.mock.calls.map(([command]) => command).filter((command) => command instanceof BatchGetCommand);
    expect(reads).toHaveLength(2);
    expect(reads.map((command) => command.input.RequestItems?.[TABLE_NAME]?.Keys?.length)).toEqual([100, 18]);
  });

  it("returns per-team failures so a partial batch can be retried", async () => {
    failKey = "b";
    const response = await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }, { apiKeyId: "b", status: "ACTIVE" }]));
    expect(response.status).toBe(422);
    const body = await response.json() as { results: { status: string }[] };
    expect(body.results.map((result) => result.status)).toEqual(["updated", "failed"]);
    expect(teams.get("a")?.status).toBe("DISABLED");
    expect(teams.get("b")?.status).toBe("DISABLED");
    failKey = null;
    expect((await handleAdminStatusUpdate(request([{ apiKeyId: "b", status: "ACTIVE" }]))).status).toBe(200);
  });

  it("invalidates cached quotas so saved checkbox states reload immediately", async () => {
    expect((await getEnrichedQuota()).find((team) => team.apiKeyId === "a")?.status).toBe("ACTIVE");
    await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }]));
    expect((await getEnrichedQuota()).find((team) => team.apiKeyId === "a")?.status).toBe("DISABLED");
    const scans = send.mock.calls.map(([command]) => command).filter((command) => command instanceof ScanCommand);
    expect(scans).toHaveLength(2);
    expect(scans.every((command) => command.input.ConsistentRead)).toBe(true);
  });

  it("does not write when lookup fails", async () => {
    send.mockImplementation(async () => { throw new Error("Simulated read failure"); });
    const response = await handleAdminStatusUpdate(request([{ apiKeyId: "a", status: "DISABLED" }]));
    expect(response.status).toBe(503);
    expect(teams.get("a")?.status).toBe("ACTIVE");
  });

  it("retries unprocessed read keys instead of treating them as missing teams", async () => {
    send.mockImplementationOnce(async () => ({ $metadata: {}, Responses: { [TABLE_NAME]: [seed("a")] },
      UnprocessedKeys: { [TABLE_NAME]: { Keys: [{ apiKeyId: "b" }], ConsistentRead: true } } }));
    const records = await getQuotasByKey(["a", "b"]);
    expect(records.size).toBe(2);
    expect(records.get("b")?.status).toBe("DISABLED");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("refuses to create a quota row for a key deleted before its update", async () => {
    await expect(setTeamStatus("missing", "ACTIVE")).rejects.toThrow("ConditionalCheckFailedException");
    expect(teams.has("missing")).toBe(false);
  });
});
