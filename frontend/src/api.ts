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

export interface AdminUpdateResult {
  apiKeyId: string;
  teamId: string | null;
  oldLimit: number;
  newLimit: number;
}

export async function updateQuota(
  token: string,
  updates: { apiKeyId: string; tokenLimit: number }[]
): Promise<{ updated: AdminUpdateResult[] }> {
  const res = await fetch(`${API_BASE}/api/admin/quota`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ updates }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failed = (body as { results?: { apiKeyId: string; status: string }[] }).results?.filter(
      (r) => r.status !== "updated"
    );
    const detail = failed?.length
      ? failed
          .map((r) =>
            r.status === "exceeded"
              ? `${r.apiKeyId}: over daily allowance`
              : `${r.apiKeyId}: ${r.status}`
          )
          .join("; ")
      : undefined;
    throw new Error(detail ?? (body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }

  const results = (body as { results?: { apiKeyId: string; teamId: string | null; oldLimit: number; requestedLimit: number; status: string }[] }).results ?? [];
  return {
    updated: results
      .filter((r) => r.status === "updated")
      .map((r) => ({ apiKeyId: r.apiKeyId, teamId: r.teamId, oldLimit: r.oldLimit, newLimit: r.requestedLimit })),
  };
}
