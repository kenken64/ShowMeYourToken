import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchQuota, updateQuota, updateTeamStatus, type AdminUpdateResult, type AdminStatusUpdateResult } from "./api";
import type { QuotaItem, TeamUsageStatus } from "./types";

const SESSION_KEY = "admin-token";
const PAGE_SIZE = 20;

type SortKey = "team" | "used" | "limit";
type SortDir = "asc" | "desc";

const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  team: "asc",
  used: "desc",
  limit: "desc",
};

function compareItems(a: QuotaItem, b: QuotaItem, key: SortKey): number {
  switch (key) {
    case "team":
      return (a.teamName ?? a.teamId).localeCompare(b.teamName ?? b.teamId);
    case "used":
      return a.usedTokens - b.usedTokens;
    case "limit":
      return a.tokenLimit - b.tokenLimit;
  }
}

function loadToken(): string {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const [tokenDraft, setTokenDraft] = useState(loadToken);
  const [items, setItems] = useState<QuotaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [bulkLimit, setBulkLimit] = useState("");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AdminUpdateResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusDrafts, setStatusDrafts] = useState<Map<string, TeamUsageStatus>>(new Map());
  const [applyingStatus, setApplyingStatus] = useState(false);
  const [statusResult, setStatusResult] = useState<AdminStatusUpdateResult[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [sortKey, setSortKey] = useState<SortKey>("team");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_SORT_DIR[key]);
    }
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : "");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchQuota();
      setItems(data.items);
      setSelected((previous) => new Set([...previous].filter((key) => data.items.some((item) => item.apiKeyId === key))));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...items].sort((a, b) => {
      const aEnabled = (statusDrafts.get(a.apiKeyId) ?? a.status) === "ACTIVE";
      const bEnabled = (statusDrafts.get(b.apiKeyId) ?? b.status) === "ACTIVE";
      return Number(bEnabled) - Number(aEnabled) || compareItems(a, b, sortKey) * dir;
    });
    const query = search.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter(
      (i) =>
        i.teamId.toLowerCase().includes(query) ||
        i.teamName?.toLowerCase().includes(query) ||
        i.apiKeyId.toLowerCase().includes(query)
    );
  }, [items, search, sortKey, sortDir, statusDrafts]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const busy = applying || applyingStatus;
  const selectedMatchingCount = filtered.filter((item) => selected.has(item.apiKeyId)).length;
  const allMatchingSelected = filtered.length > 0 && selectedMatchingCount === filtered.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedMatchingCount > 0 && !allMatchingSelected;
    }
  }, [selectedMatchingCount, allMatchingSelected, loading]);

  const pendingStatusUpdates = useMemo(() => items.flatMap((item) => {
    const status = statusDrafts.get(item.apiKeyId);
    return status && status !== item.status ? [{ apiKeyId: item.apiKeyId, status }] : [];
  }), [items, statusDrafts]);

  const stageStatus = (teams: QuotaItem[], status: TeamUsageStatus) => {
    setStatusDrafts((previous) => {
      const next = new Map(previous);
      for (const item of teams) {
        if (status === item.status) next.delete(item.apiKeyId);
        else next.set(item.apiKeyId, status);
      }
      return next;
    });
    setStatusResult(null);
    setStatusError(null);
  };

  const applyStatusChanges = async () => {
    if (pendingStatusUpdates.length === 0 || busy) return;
    setApplyingStatus(true);
    setStatusResult(null);
    setStatusError(null);
    try {
      const response = await updateTeamStatus(token, pendingStatusUpdates);
      const updated = response.results.filter((result) => result.status === "updated");
      const failed = response.results.filter((result) => result.status !== "updated");
      const updatedKeys = new Set(updated.map((result) => result.apiKeyId));
      setStatusResult(updated.length > 0 ? updated : null);
      setStatusDrafts((previous) => new Map([...previous].filter(([key]) => !updatedKeys.has(key))));
      if (failed.length > 0) {
        setStatusError(`Could not update ${failed.map((result) => result.teamId ?? result.apiKeyId).join(", ")}. Their usage changes are still pending.`);
      }
      await load();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to update team usage");
    } finally {
      setApplyingStatus(false);
    }
  };

  const pendingCount = useMemo(() => {
    let n = 0;
    for (const [apiKeyId, draft] of drafts) {
      const item = items.find((i) => i.apiKeyId === apiKeyId);
      const value = Number(draft);
      if (item && draft.trim() !== "" && Number.isInteger(value) && value >= 0 && value !== item.tokenLimit) {
        n++;
      }
    }
    return n;
  }, [drafts, items]);

  const saveToken = () => {
    try {
      sessionStorage.setItem(SESSION_KEY, tokenDraft.trim());
    } catch {
      // sessionStorage unavailable; token stays in memory only
    }
    setToken(tokenDraft.trim());
  };

  const setLimitForAllTeams = (value: string) => {
    setBulkLimit(value);

    const tokenLimit = Number(value);
    if (value.trim() === "" || !Number.isInteger(tokenLimit) || tokenLimit < 0) {
      setDrafts(new Map());
      return;
    }

    setDrafts(new Map(items.map((item) => [item.apiKeyId, value])));
  };

  const applyChanges = async () => {
    const updates = [...drafts.entries()]
      .map(([apiKeyId, draft]) => {
        const item = items.find((i) => i.apiKeyId === apiKeyId);
        const tokenLimit = Number(draft);
        return item && draft.trim() !== "" && Number.isInteger(tokenLimit) && tokenLimit >= 0 && tokenLimit !== item.tokenLimit
          ? { apiKeyId, tokenLimit }
          : null;
      })
      .filter((u): u is { apiKeyId: string; tokenLimit: number } => u !== null);

    if (updates.length === 0) return;

    setApplying(true);
    setResult(null);
    setApplyError(null);
    try {
      const res = await updateQuota(token, updates);
      setResult(res.updated);
      setDrafts(new Map());
      setBulkLimit("");
      await load();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setApplying(false);
    }
  };

  if (!token) {
    return (
      <main className="page admin-page">
        <div className="card admin-card admin-login-card">
          <div className="admin-header">
            <h1>Admin sign in</h1>
            <a className="admin-back" href="/">← Dashboard</a>
          </div>
          <p className="admin-hint">Enter the admin token to manage team token limits and Bedrock access.</p>
          <form
            className="admin-login"
            onSubmit={(e) => {
              e.preventDefault();
              saveToken();
            }}
          >
            <input
              type="password"
              className="search-input"
              placeholder="Admin token"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              autoFocus
            />
            <button type="submit" className="refresh-button" disabled={!tokenDraft.trim()}>
              Sign in
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="page admin-page">
      <div className="card admin-card">
        <div className="admin-header">
          <h1>Team quota and access</h1>
          <div className="admin-header-actions">
            <a className="admin-back" href="/">← Dashboard</a>
            <button
              type="button"
              className="tab"
              disabled={busy}
              onClick={() => {
                try {
                  sessionStorage.removeItem(SESSION_KEY);
                } catch {
                  // ignore
                }
                setToken("");
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {loading && <div className="state">Loading…</div>}
        {error && <div className="state error">Failed to load: {error}</div>}

        {!loading && !error && (
          <>
            <div className="admin-bulk-control">
              <label htmlFor="bulk-limit">New limit for all teams</label>
              <input
                id="bulk-limit"
                type="number"
                className="search-input admin-bulk-input"
                min={0}
                step={1}
                placeholder="Enter token limit"
                value={bulkLimit}
                disabled={busy}
                onChange={(e) => setLimitForAllTeams(e.target.value)}
              />
            </div>

            <div className="toolbar">
              <div className="search-wrap">
                <input
                  type="search"
                  className="search-input"
                  placeholder="Search team ID, name, or API key…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search teams"
                />
              </div>
              <button
                type="button"
                className="refresh-button"
                onClick={applyChanges}
                disabled={busy || pendingCount === 0}
              >
                {applying ? "Applying…" : `Apply ${pendingCount > 0 ? `${pendingCount} ` : ""}limit change${pendingCount === 1 ? "" : "s"}`}
              </button>
            </div>

            <section className="admin-usage-control" aria-label="Team usage controls">
              <div className="admin-usage-heading">
                <strong>Bedrock access</strong>
                <span>{selected.size} team{selected.size === 1 ? "" : "s"} selected across all pages</span>
              </div>
              <div className="admin-usage-actions">
                <button type="button" className="tab" disabled={busy || selected.size === 0} onClick={() => stageStatus(items.filter((item) => selected.has(item.apiKeyId)), "ACTIVE")}>
                  Enable selected
                </button>
                <button type="button" className="tab" disabled={busy || selected.size === 0} onClick={() => stageStatus(items.filter((item) => selected.has(item.apiKeyId)), "DISABLED")}>
                  Disable selected
                </button>
                <button type="button" className="tab" disabled={busy || items.length === 0} onClick={() => stageStatus(items, "ACTIVE")}>
                  Enable all {items.length} teams
                </button>
                <button type="button" className="tab" disabled={busy || items.length === 0} onClick={() => stageStatus(items, "DISABLED")}>
                  Disable all {items.length} teams
                </button>
                <button type="button" className="refresh-button" disabled={busy || pendingStatusUpdates.length === 0} onClick={applyStatusChanges}>
                  {applyingStatus ? "Applying usage changes…" : `Apply ${pendingStatusUpdates.length} usage change${pendingStatusUpdates.length === 1 ? "" : "s"}`}
                </button>
                {pendingStatusUpdates.length > 0 && (
                  <button type="button" className="tab" disabled={busy} onClick={() => { setStatusDrafts(new Map()); setStatusError(null); }}>
                    Discard usage changes
                  </button>
                )}
              </div>
              <p>Changes take effect when you apply usage changes. Disabled teams cannot send new Bedrock requests. Select all in the table includes matching teams on every page.</p>
            </section>

            {statusError && <div className="state error" role="alert">Usage update failed: {statusError}</div>}
            {statusResult && (
              <div className="state admin-success" role="status">
                Usage updated for {statusResult.length} team{statusResult.length === 1 ? "" : "s"}: {statusResult.filter((result) => result.newStatus === "ACTIVE").length} enabled, {statusResult.filter((result) => result.newStatus === "DISABLED").length} disabled.
              </div>
            )}

            {applyError && <div className="state error">Update failed: {applyError}</div>}
            {result && (
              <div className="state admin-success">
                Updated {result.length} team{result.length === 1 ? "" : "s"}:{" "}
                {result.map((r) => `${r.teamId ?? r.apiKeyId} ${r.oldLimit.toLocaleString()} → ${r.newLimit.toLocaleString()}`).join(", ")}
              </div>
            )}

            <div className="table-wrap">
              <table className="quota-table admin-quota-table">
                <colgroup>
                  <col className="admin-select-column" />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col className="admin-limit-column" />
                  <col className="admin-access-column" />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        className="admin-checkbox"
                        aria-label={search.trim() ? "Select all matching teams" : "Select all teams"}
                        checked={allMatchingSelected}
                        disabled={busy || filtered.length === 0}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelected((previous) => {
                            const next = new Set(previous);
                            for (const item of filtered) {
                              if (checked) next.add(item.apiKeyId);
                              else next.delete(item.apiKeyId);
                            }
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="sortable" aria-sort={sortKey === "team" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("team")}>
                      Team <span className="sort-arrow">{sortArrow("team")}</span>
                    </th>
                    <th>API key</th>
                    <th className="sortable" aria-sort={sortKey === "used" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("used")}>
                      Used <span className="sort-arrow">{sortArrow("used")}</span>
                    </th>
                    <th className="sortable" aria-sort={sortKey === "limit" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("limit")}>
                      Current limit <span className="sort-arrow">{sortArrow("limit")}</span>
                    </th>
                    <th>New limit</th>
                    <th>Usage enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-cell">No teams match “{search}”</td>
                    </tr>
                  )}
                  {pageItems.map((item) => {
                    const draft = drafts.get(item.apiKeyId) ?? "";
                    const usageStatus = statusDrafts.get(item.apiKeyId) ?? item.status;
                    const statusDirty = usageStatus !== item.status;
                    const dirty = (draft.trim() !== "" && Number(draft) !== item.tokenLimit) || statusDirty;
                    const exceeded = item.tokenLimit > 0 && item.usedTokens >= item.tokenLimit;
                    const rowClass = [dirty ? "admin-row-dirty" : "", exceeded ? "admin-row-exceeded" : ""]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <tr key={item.apiKeyId} className={rowClass}>
                        <td>
                          <input
                            type="checkbox"
                            className="admin-checkbox"
                            aria-label={`Select ${item.teamId}`}
                            checked={selected.has(item.apiKeyId)}
                            disabled={busy}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelected((previous) => {
                                const next = new Set(previous);
                                if (checked) next.add(item.apiKeyId);
                                else next.delete(item.apiKeyId);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td>
                          <div className="admin-team">
                            <span className="team-name-cell">{item.teamName ?? "—"}</span>
                            <span className="team-cell">{item.teamId}</span>
                          </div>
                        </td>
                        <td className="team-cell">{item.apiKeyId}</td>
                        <td className={exceeded ? "admin-used-exceeded" : ""}>
                          {item.usedTokens.toLocaleString()}
                          {exceeded && <span className="admin-exceeded-badge">Exceeded</span>}
                        </td>
                        <td>{item.tokenLimit.toLocaleString()}</td>
                        <td>
                          <input
                            type="number"
                            className="search-input admin-limit-input"
                            min={0}
                            step={1}
                            placeholder={String(item.tokenLimit)}
                            value={draft}
                            disabled={busy}
                            onChange={(e) => {
                              setBulkLimit("");
                              const next = new Map(drafts);
                              if (e.target.value === "") next.delete(item.apiKeyId);
                              else next.set(item.apiKeyId, e.target.value);
                              setDrafts(next);
                            }}
                          />
                        </td>
                        <td>
                          <label className="admin-usage-checkbox">
                            <input
                              type="checkbox"
                              className="admin-checkbox"
                              aria-label={`Usage enabled for ${item.teamId}`}
                              checked={usageStatus === "ACTIVE"}
                              disabled={busy}
                              onChange={(event) => stageStatus([item], event.target.checked ? "ACTIVE" : "DISABLED")}
                            />
                            <span>{usageStatus === "ACTIVE" ? "Enabled" : "Disabled"}{statusDirty && <small>Pending</small>}</span>
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <span className="range">
                {(currentPage - 1) * PAGE_SIZE + (pageItems.length > 0 ? 1 : 0)}–
                {Math.min(filtered.length, currentPage * PAGE_SIZE)} of {filtered.length}
              </span>
              <div className="pagination-controls">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
                  Previous
                </button>
                <span className="page-indicator">Page {currentPage} of {totalPages}</span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
