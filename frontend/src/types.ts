export interface QuotaItem {
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

export interface QuotaResponse {
  items: QuotaItem[];
  count: number;
}

export interface CostTrendPoint {
  date: string;
  amount: number;
}

export interface BillingSummary {
  amount: number;
  unit: string;
  periodStart: string;
  periodEnd: string;
  estimated: boolean;
  updatedAt: string;
  trend: CostTrendPoint[];
}
