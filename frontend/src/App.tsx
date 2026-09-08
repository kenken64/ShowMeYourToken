import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchBilling, fetchQuota } from "./api";
import { CategoryMeter, QuotaStatusMeter, TopUsageChart } from "./Insights";
import type { BillingSummary, QuotaItem } from "./types";
import "./App.css";

const PAGE_SIZE = 50;
const REFRESH_INTERVAL_MS = 60_000;

function usagePercent(item: QuotaItem) {
  if (item.tokenLimit <= 0) return 0;
  return Math.min(100, (item.usedTokens / item.tokenLimit) * 100);
}

function usageLevel(pct: number) {
  if (pct >= 100) return "critical";
  if (pct >= 75) return "high";
  return "normal";
}

function isExceeded(item: QuotaItem) {
  return item.tokenLimit > 0 && item.usedTokens >= item.tokenLimit;
}

function formatCost(billing: BillingSummary) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: billing.unit,
      maximumFractionDigits: 2,
    }).format(billing.amount);
  } catch {
    return `${billing.amount.toFixed(2)} ${billing.unit}`;
  }
}

function CoinIcon() {
  return (
    <svg className="coin-icon" viewBox="0 0 24 24" width="0.8em" height="0.8em" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#f5b301" stroke="#c98500" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="#c98500" strokeWidth="1" opacity="0.6" />
    </svg>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;

  const width = 72;
  const height = 22;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

type Tab = "exceeded" | "remaining";
type SortKey = "name" | "id" | "category" | "usage";
type SortDir = "asc" | "desc";

const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  id: "asc",
  category: "asc",
  usage: "desc",
};

function compareItems(a: QuotaItem, b: QuotaItem, key: SortKey): number {
  switch (key) {
    case "name":
      return (a.teamName ?? "").localeCompare(b.teamName ?? "");
    case "id":
      return a.teamId.localeCompare(b.teamId);
    case "category":
      return (a.category ?? "").localeCompare(b.category ?? "");
    case "usage":
      return usagePercent(a) - usagePercent(b);
  }
}

function App() {
  const [items, setItems] = useState<QuotaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("remaining");
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("usage");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [insightsOpen, setInsightsOpen] = useState(false);
  const hasLoadedRef = useRef(false);

  const loadQuota = useCallback(() => {
    setRefreshing(true);
    return fetchQuota()
      .then((data) => {
        setItems(data.items);
        setError(null);
        setRefreshError(null);
        setLastUpdated(new Date());
        hasLoadedRef.current = true;
      })
      .catch((err) => {
        console.error("Failed to load quota:", err);
        if (hasLoadedRef.current) {
          setRefreshError(err.message);
        } else {
          setError(err.message);
        }
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  const loadBilling = useCallback(() => {
    return fetchBilling()
      .then(setBilling)
      .catch((err) => console.error("Failed to load billing:", err));
  }, []);

  useEffect(() => {
    loadQuota();
    const interval = setInterval(() => loadQuota(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadQuota]);

  useEffect(() => {
    loadBilling();
  }, [loadBilling]);

  const handleRefresh = () => {
    loadQuota();
    loadBilling();
  };

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_SORT_DIR[key]);
    }
  };

  const exceededCount = useMemo(
    () => items.filter(isExceeded).length,
    [items]
  );
  const remainingCount = items.length - exceededCount;

  const byTab = useMemo(
    () => items.filter((item) => isExceeded(item) === (tab === "exceeded")),
    [items, tab]
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...byTab].sort((a, b) => compareItems(a, b, sortKey) * dir);
  }, [byTab, sortKey, sortDir]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter(
      (item) =>
        item.teamId.toLowerCase().includes(query) ||
        item.teamName?.toLowerCase().includes(query)
    );
  }, [sorted, search]);

  useEffect(() => {
    setPage(1);
  }, [search, tab]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );
  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(filtered.length, currentPage * PAGE_SIZE);

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : "");

  return (
    <main className="page">
      <div className="card">
        <header className="card-header">
          <div className="title-group">
            <div className="logo-group">
              <img className="logo" src="/images/branding-nus.png" alt="NUS" />
              <img
                className="logo"
                src="/images/iss-logo-small-space.png"
                alt="ISS"
              />
            </div>
            <h1>
              <span className="title-gradient">ShowMeYourAgent</span> T<CoinIcon />ken Dashboard
            </h1>
          </div>
          <div className="header-stats">
            {!loading && !error && (
              <span className="subtitle">{items.length} teams</span>
            )}
            {billing && (
              <span className="billing-chip" title={`AWS cost ${billing.periodStart} to ${billing.periodEnd}${billing.estimated ? " (estimated)" : ""}`}>
                {formatCost(billing)} MTD
                {billing.trend.length > 1 && <Sparkline points={billing.trend.map((p) => p.amount)} />}
              </span>
            )}
          </div>
        </header>

        {loading && <div className="state">Loading…</div>}
        {error && <div className="state error">Failed to load: {error}</div>}

        {!loading && !error && (
          <>
            <div className="insights-section">
              <button
                type="button"
                className="insights-toggle"
                onClick={() => setInsightsOpen((v) => !v)}
                aria-expanded={insightsOpen}
              >
                {insightsOpen ? "Hide overview" : "Show overview"}
              </button>
              {insightsOpen && (
                <div className="insights-grid">
                  <QuotaStatusMeter exceededCount={exceededCount} remainingCount={remainingCount} />
                  <CategoryMeter items={items} />
                  <TopUsageChart items={items} />
                </div>
              )}
            </div>

            <div className="tabs">
              <button
                type="button"
                className={tab === "remaining" ? "tab active" : "tab"}
                onClick={() => setTab("remaining")}
              >
                Has Quota
                <span className="tab-count">{remainingCount}</span>
              </button>
              <button
                type="button"
                className={tab === "exceeded" ? "tab active" : "tab"}
                onClick={() => setTab("exceeded")}
              >
                Exceeded
                <span className="tab-count">{exceededCount}</span>
              </button>
            </div>

            <div className="toolbar">
              <input
                type="search"
                className="search-input"
                placeholder="Search team ID or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search team ID or name"
              />
              <div className="refresh-group">
                {lastUpdated && (
                  <span className="updated-at">Updated {lastUpdated.toLocaleTimeString()}</span>
                )}
                {refreshError && (
                  <span className="refresh-error" title={refreshError}>
                    Refresh failed
                  </span>
                )}
                <button
                  type="button"
                  className="refresh-button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  aria-label="Refresh now"
                >
                  <span className={refreshing ? "refresh-icon spinning" : "refresh-icon"}>↻</span>
                  Refresh
                </button>
              </div>
            </div>

            <div className="table-wrap">
              <table className="quota-table">
                <colgroup>
                  <col className="col-name" />
                  <col className="col-id" />
                  <col className="col-category" />
                  <col className="col-usage" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="sortable" aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("name")}>
                      Team Name <span className="sort-arrow">{sortArrow("name")}</span>
                    </th>
                    <th className="sortable" aria-sort={sortKey === "id" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("id")}>
                      Team ID <span className="sort-arrow">{sortArrow("id")}</span>
                    </th>
                    <th className="sortable" aria-sort={sortKey === "category" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("category")}>
                      Category <span className="sort-arrow">{sortArrow("category")}</span>
                    </th>
                    <th className="sortable" aria-sort={sortKey === "usage" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => handleSort("usage")}>
                      Used / Limit <span className="sort-arrow">{sortArrow("usage")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty-cell">
                        {search
                          ? `No teams match “${search}”`
                          : tab === "exceeded"
                          ? "No teams have exceeded their quota"
                          : "No teams have remaining quota"}
                      </td>
                    </tr>
                  )}
                  {pageItems.map((item) => {
                    const pct = usagePercent(item);
                    const level = usageLevel(pct);
                    return (
                      <tr key={item.apiKeyId}>
                        <td className="team-name-cell">{item.teamName ?? "—"}</td>
                        <td className="team-cell">{item.teamId}</td>
                        <td>
                          {item.category ? (
                            <span className="category-badge">{item.category}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <div className="usage-cell">
                            <div className="usage-numbers">
                              <span>{item.usedTokens.toLocaleString()}</span>
                              <span className="of">/</span>
                              <span className="limit">
                                {item.tokenLimit.toLocaleString()}
                              </span>
                            </div>
                            <div className="usage-bar" data-level={level}>
                              <div
                                className="usage-bar-fill"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <span className="range">
                {rangeStart}–{rangeEnd} of {filtered.length}
              </span>
              <div className="pagination-controls">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </button>
                <span className="page-indicator">
                  Page {currentPage} of {totalPages}
                </span>
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

export default App;
