export interface QuotaItem {
  teamId: string;
  apiKeyId: string;
  tokenLimit: number;
  usedTokens: number;
  reservedTokens: number;
  status: string;
}

export interface QuotaResponse {
  items: QuotaItem[];
  count: number;
}
