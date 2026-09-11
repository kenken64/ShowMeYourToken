import { scanTable } from "./dynamo";
import { getTeamInfo } from "./teamDirectory";

export interface EnrichedQuotaItem {
  teamId: string;
  apiKeyId: string;
  tokenLimit: number;
  usedTokens: number;
  reservedTokens: number;
  status: string;
  teamCode: string | null;
  teamName: string | null;
  category: string | null;
}

const CACHE_TTL_MS = Number(process.env.QUOTA_CACHE_TTL_SECONDS ?? 20) * 1_000;

let cache: EnrichedQuotaItem[] | null = null;
let cacheFetchedAt = 0;

async function fetchEnrichedQuota(): Promise<EnrichedQuotaItem[]> {
  const items = await scanTable();
  return items.map((item) => {
    const teamId = item.teamId;
    const info = typeof teamId === "string" ? getTeamInfo(teamId) : undefined;
    return {
      ...item,
      teamCode: info?.teamCode ?? null,
      teamName: info?.teamName ?? null,
      category: info?.category ?? null,
    } as EnrichedQuotaItem;
  });
}

/** Cached DynamoDB scan + team-directory join; refetches at most once per QUOTA_CACHE_TTL_SECONDS. */
export async function getEnrichedQuota(): Promise<EnrichedQuotaItem[]> {
  const now = Date.now();
  if (cache && now - cacheFetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  const items = await fetchEnrichedQuota();
  cache = items;
  cacheFetchedAt = now;
  return items;
}

/** Drops the cached scan so the next getEnrichedQuota() refetches from DynamoDB. */
export function invalidateQuotaCache(): void {
  cache = null;
  cacheFetchedAt = 0;
}
