import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const CACHE_TTL_MS = Number(process.env.COST_CACHE_TTL_MINUTES ?? 360) * 60_000;

// Cost Explorer is only available in us-east-1, regardless of where the
// billed resources actually live.
const client =
  accessKeyId && secretAccessKey
    ? new CostExplorerClient({ region: "us-east-1", credentials: { accessKeyId, secretAccessKey } })
    : null;

export interface BillingSummary {
  amount: number;
  unit: string;
  periodStart: string;
  periodEnd: string;
  estimated: boolean;
  updatedAt: string;
}

let cache: BillingSummary | null = null;
let cacheFetchedAt = 0;

function monthToDateRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

async function fetchMonthToDateCost(): Promise<BillingSummary> {
  if (!client) {
    throw new Error("Missing AWS credentials for Cost Explorer");
  }

  const { start, end } = monthToDateRange();
  const res = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
    })
  );

  const result = res.ResultsByTime?.[0];
  const cost = result?.Total?.UnblendedCost;

  return {
    amount: Number(cost?.Amount ?? 0),
    unit: cost?.Unit ?? "USD",
    periodStart: start,
    periodEnd: end,
    estimated: result?.Estimated ?? true,
    updatedAt: new Date().toISOString(),
  };
}

/** Cached month-to-date account cost; refetches at most once per COST_CACHE_TTL_MINUTES. */
export async function getMonthToDateCost(): Promise<BillingSummary> {
  const now = Date.now();
  if (cache && now - cacheFetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  const summary = await fetchMonthToDateCost();
  cache = summary;
  cacheFetchedAt = now;
  return summary;
}
