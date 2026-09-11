import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
export const TABLE_NAME = process.env.TABLE_NAME ?? "LLMTeamQuota";

if (!region || !accessKeyId || !secretAccessKey) {
  throw new Error(
    "Missing AWS credentials/region. Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in backend/.env"
  );
}

const client = new DynamoDBClient({
  region,
  credentials: { accessKeyId, secretAccessKey },
});

export const ddb = DynamoDBDocumentClient.from(client);

export const LOCK_TABLE_NAME = process.env.LOCK_TABLE_NAME ?? "LLMReportLock";

/** Claims a named lock; returns false if another process holds it. Lock auto-expires via DynamoDB TTL. */
export async function tryAcquireLock(lockId: string, ttlSeconds: number): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: LOCK_TABLE_NAME,
        Item: {
          lockId,
          expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        ConditionExpression: "attribute_not_exists(lockId)",
      })
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export async function scanTable(tableName: string = TABLE_NAME) {
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastEvaluatedKey })
    );
    items.push(...(result.Items ?? []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

export interface QuotaKeyRow {
  apiKeyId: string;
  teamId: string | null;
  tokenLimit: number;
}

/** Fetches existing rows by apiKeyId (table partition key). Missing keys are absent from the result. */
export async function getQuotasByKey(apiKeyIds: string[]): Promise<Map<string, QuotaKeyRow>> {
  const found = new Map<string, QuotaKeyRow>();
  const uniqueIds = [...new Set(apiKeyIds)];

  // BatchGetItem supports at most 100 keys per call.
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds.slice(i, i + 100);
    const result = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE_NAME]: {
            Keys: chunk.map((apiKeyId) => ({ apiKeyId })),
            ProjectionExpression: "apiKeyId, teamId, tokenLimit",
          },
        },
      })
    );
    for (const item of result.Responses?.[TABLE_NAME] ?? []) {
      const apiKeyId = item.apiKeyId;
      if (typeof apiKeyId !== "string") continue;
      found.set(apiKeyId, {
        apiKeyId,
        teamId: typeof item.teamId === "string" ? item.teamId : null,
        tokenLimit: typeof item.tokenLimit === "number" ? item.tokenLimit : 0,
      });
    }
  }

  return found;
}

export interface AllowanceState {
  used: number;
  windowStart: number;
}

/**
 * Atomically consumes `amount` from a team's daily (rolling 24h) allowance.
 * Returns the remaining allowance on success, or null if the request would exceed the limit.
 */
export async function consumeDailyAllowance(
  apiKeyId: string,
  amount: number,
  dailyLimit: number
): Promise<{ remaining: number } | null> {
  const windowMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const key = { lockId: `quota-allowance#${apiKeyId}` };

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await ddb.send(
      new GetCommand({ TableName: LOCK_TABLE_NAME, Key: key })
    );
    const raw = current.Item as { used?: number; windowStart?: number } | undefined;
    const inWindow = raw && typeof raw.windowStart === "number" && now - raw.windowStart < windowMs;
    const used = inWindow && typeof raw.used === "number" ? raw.used : 0;
    const windowStart = inWindow ? raw.windowStart! : now;

    if (used + amount > dailyLimit) return null;

    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE_NAME,
          Item: {
            ...key,
            used: used + amount,
            windowStart,
            expiresAt: Math.floor((windowStart + windowMs) / 1000) + 60 * 60, // TTL grace period
          },
          ConditionExpression:
            "attribute_not_exists(lockId) OR (used = :u AND windowStart = :w)",
          ExpressionAttributeValues: { ":u": used, ":w": windowStart },
        })
      );
      return { remaining: dailyLimit - (used + amount) };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) continue; // lost a race; reload and retry
      throw err;
    }
  }

  return null; // contended too many times; treat as rejected
}

/** Sets tokenLimit only if it currently equals expectedOld. Returns false if the row changed underneath us. */
export async function setTokenLimitIfUnchanged(
  apiKeyId: string,
  tokenLimit: number,
  expectedOld: number
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { apiKeyId },
        UpdateExpression: "SET tokenLimit = :limit",
        ConditionExpression: "tokenLimit = :expected",
        ExpressionAttributeValues: { ":limit": tokenLimit, ":expected": expectedOld },
      })
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/** Unconditionally sets tokenLimit (used for decreases, which don't consume allowance). */
export async function setTokenLimit(apiKeyId: string, tokenLimit: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { apiKeyId },
      UpdateExpression: "SET tokenLimit = :limit",
      ExpressionAttributeValues: { ":limit": tokenLimit },
    })
  );
}

/** Reads the current daily allowance state for display purposes (no mutation). */
export async function getAllowanceState(apiKeyId: string, dailyLimit: number): Promise<{ remaining: number }> {
  const windowMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const result = await ddb.send(
    new GetCommand({
      TableName: LOCK_TABLE_NAME,
      Key: { lockId: `quota-allowance#${apiKeyId}` },
    })
  );
  const raw = result.Item as { used?: number; windowStart?: number } | undefined;
  const inWindow = raw && typeof raw.windowStart === "number" && now - raw.windowStart < windowMs;
  const used = inWindow && typeof raw.used === "number" ? raw.used : 0;
  return { remaining: Math.max(0, dailyLimit - used) };
}
