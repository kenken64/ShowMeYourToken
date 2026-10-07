import type { BillingSummary, QuotaResponse, TeamUsageStatus } from "./types";

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

export interface AdminStatusUpdateResult {
  apiKeyId: string;
  teamId: string | null;
  oldStatus: string | null;
  newStatus: TeamUsageStatus;
  status: "updated" | "failed";
}

export async function updateTeamStatus(
  token: string,
  updates: { apiKeyId: string; status: TeamUsageStatus }[]
): Promise<{ results: AdminStatusUpdateResult[] }> {
  const res = await fetch(`${API_BASE}/api/admin/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ updates }),
  });
  const body = await res.json().catch(() => ({})) as { error?: string; results?: AdminStatusUpdateResult[] };
  // A partially applied batch returns results so successful changes can be reconciled.
  if ((!res.ok && res.status !== 422) || !Array.isArray(body.results)) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return { results: body.results };
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
