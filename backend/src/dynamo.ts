import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

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
