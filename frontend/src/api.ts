import type { BillingSummary, QuotaResponse } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function fetchQuota(): Promise<QuotaResponse> {
  const res = await fetch(`${API_BASE}/api/quota`);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchBilling(): Promise<BillingSummary> {
  const res = await fetch(`${API_BASE}/api/billing`);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}
