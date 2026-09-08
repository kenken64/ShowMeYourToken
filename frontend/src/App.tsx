import { useEffect, useMemo, useState } from "react";
import { fetchBilling, fetchQuota } from "./api";
import type { BillingSummary, QuotaItem } from "./types";
import "./App.css";

const PAGE_SIZE = 50;

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

type Tab = "exceeded" | "remaining";

function App() {
  const [items, setItems] = useState<QuotaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("remaining");
  const [billing, setBilling] = useState<BillingSummary | null>(null);

  useEffect(() => {
    fetchQuota()
      .then((data) => setItems(data.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchBilling()
      .then(setBilling)
      .catch((err) => console.error("Failed to load billing:", err));
  }, []);

  const exceededCount = useMemo(
    () => items.filter(isExceeded).length,
    [items]
  );
  const remainingCount = items.length - exceededCount;

  const byTab = useMemo(
    () => items.filter((item) => isExceeded(item) === (tab === "exceeded")),
    [items, tab]
  );

  const sorted = useMemo(
    () => [...byTab].sort((a, b) => usagePercent(b) - usagePercent(a)),
    [byTab]
  );

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
              <span className="title-gradient">ShowMeYourAgent</span> Token Dashboard
            </h1>
          </div>
          <div className="header-stats">
            {!loading && !error && (
              <span className="subtitle">{items.length} teams</span>
            )}
            {billing && (
              <span className="billing-chip" title={`AWS cost ${billing.periodStart} to ${billing.periodEnd}${billing.estimated ? " (estimated)" : ""}`}>
                {formatCost(billing)} MTD
              </span>
            )}
          </div>
        </header>

        {loading && <div className="state">Loading…</div>}
        {error && <div className="state error">Failed to load: {error}</div>}

        {!loading && !error && (
          <>
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
                    <th>Team Name</th>
                    <th>Team ID</th>
                    <th>Category</th>
                    <th>Used / Limit</th>
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
