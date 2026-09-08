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

export async function getEnrichedQuota(): Promise<EnrichedQuotaItem[]> {
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
