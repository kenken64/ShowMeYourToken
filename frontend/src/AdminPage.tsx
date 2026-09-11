import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQuota, updateQuota, type AdminUpdateResult } from "./api";
import type { QuotaItem } from "./types";

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
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AdminUpdateResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
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

  const load = useCallback(() => {
    setLoading(true);
    fetchQuota()
      .then((data) => {
        setItems(data.items);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...items].sort((a, b) => compareItems(a, b, sortKey) * dir);
    const query = search.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter(
      (i) =>
        i.teamId.toLowerCase().includes(query) ||
        i.teamName?.toLowerCase().includes(query) ||
        i.apiKeyId.toLowerCase().includes(query)
    );
  }, [items, search, sortKey, sortDir]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
      await load();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setApplying(false);
    }
  };

  if (!token) {
    return (
      <main className="page">
        <div className="card admin-card admin-login-card">
          <div className="admin-header">
            <h1>Admin sign in</h1>
            <a className="admin-back" href="/">← Dashboard</a>
          </div>
          <p className="admin-hint">Enter the admin token to manage team token limits.</p>
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
    <main className="page">
      <div className="card admin-card">
        <div className="admin-header">
          <h1>Token limit admin</h1>
          <div className="admin-header-actions">
            <a className="admin-back" href="/">← Dashboard</a>
            <button
              type="button"
              className="tab"
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
                disabled={applying || pendingCount === 0}
              >
                {applying ? "Applying…" : `Apply ${pendingCount > 0 ? `${pendingCount} ` : ""}change${pendingCount === 1 ? "" : "s"}`}
              </button>
            </div>

            {applyError && <div className="state error">Update failed: {applyError}</div>}
            {result && (
              <div className="state admin-success">
                Updated {result.length} team{result.length === 1 ? "" : "s"}:{" "}
                {result.map((r) => `${r.teamId ?? r.apiKeyId} ${r.oldLimit.toLocaleString()} → ${r.newLimit.toLocaleString()}`).join(", ")}
              </div>
            )}

            <div className="table-wrap">
              <table className="quota-table">
                <thead>
                  <tr>
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
                  </tr>
                </thead>
                <tbody>
                  {pageItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty-cell">No teams match “{search}”</td>
                    </tr>
                  )}
                  {pageItems.map((item) => {
                    const draft = drafts.get(item.apiKeyId) ?? "";
                    const dirty = draft.trim() !== "" && Number(draft) !== item.tokenLimit;
                    return (
                      <tr key={item.apiKeyId} className={dirty ? "admin-row-dirty" : ""}>
                        <td>
                          <div className="admin-team">
                            <span className="team-name-cell">{item.teamName ?? "—"}</span>
                            <span className="team-cell">{item.teamId}</span>
                          </div>
                        </td>
                        <td className="team-cell">{item.apiKeyId}</td>
                        <td>{item.usedTokens.toLocaleString()}</td>
                        <td>{item.tokenLimit.toLocaleString()}</td>
                        <td>
                          <input
                            type="number"
                            className="search-input admin-limit-input"
                            min={0}
                            step={1}
                            placeholder={String(item.tokenLimit)}
                            value={draft}
                            onChange={(e) => {
                              const next = new Map(drafts);
                              if (e.target.value === "") next.delete(item.apiKeyId);
                              else next.set(item.apiKeyId, e.target.value);
                              setDrafts(next);
                            }}
                          />
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
