import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
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

/** Sets only the tokenLimit attribute for each apiKeyId, leaving other attributes untouched. Assumes the keys exist. */
export async function setTokenLimits(updates: { apiKeyId: string; tokenLimit: number }[]): Promise<void> {
  await Promise.all(
    updates.map((u) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { apiKeyId: u.apiKeyId },
          UpdateExpression: "SET tokenLimit = :limit",
          ExpressionAttributeValues: { ":limit": u.tokenLimit },
        })
      )
    )
  );
}
