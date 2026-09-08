import type { QuotaItem } from "./types";

interface Segment {
  key: string;
  label: string;
  count: number;
  color: string;
}

function usagePercent(item: QuotaItem) {
  if (item.tokenLimit <= 0) return 0;
  return Math.min(100, (item.usedTokens / item.tokenLimit) * 100);
}

function usageTier(pct: number): "normal" | "high" | "critical" {
  if (pct >= 100) return "critical";
  if (pct >= 75) return "high";
  return "normal";
}

function StackedMeter({ title, segments }: { title: string; segments: Segment[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="insight-panel">
      <h3 className="insight-title">{title}</h3>
      <div
        className="stacked-meter"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.count}`).join(", ")}
      >
        {segments.map(
          (s) =>
            s.count > 0 && (
              <div
                key={s.key}
                className="stacked-meter-segment"
                style={{ flexGrow: s.count, background: s.color }}
                title={`${s.label}: ${s.count} (${total ? Math.round((s.count / total) * 100) : 0}%)`}
              />
            )
        )}
      </div>
      <div className="stacked-meter-legend">
        {segments.map((s) => (
          <span key={s.key} className="legend-item">
            <span className="legend-swatch" style={{ background: s.color }} />
            {s.label} <strong>{s.count}</strong>
            <span className="legend-pct">{total ? Math.round((s.count / total) * 100) : 0}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function QuotaStatusMeter({
  exceededCount,
  remainingCount,
}: {
  exceededCount: number;
  remainingCount: number;
}) {
  return (
    <StackedMeter
      title="Quota status"
      segments={[
        { key: "remaining", label: "Has quota", count: remainingCount, color: "#10b981" },
        { key: "exceeded", label: "Exceeded", count: exceededCount, color: "#ef4444" },
      ]}
    />
  );
}

const CATEGORY_PALETTE: Record<string, string> = {
  Public: "#2a78d6",
  SME: "#eb6834",
};
const FALLBACK_COLORS = ["#1baf7a", "#eda100", "#4a3aa7", "#e34948"];

export function CategoryMeter({ items }: { items: QuotaItem[] }) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.category ?? "Uncategorized";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const knownOrder = ["Public", "SME"].filter((key) => counts.has(key));
  const otherKeys = [...counts.keys()].filter((key) => key !== "Public" && key !== "SME" && key !== "Uncategorized");
  const order = [...knownOrder, ...otherKeys, ...(counts.has("Uncategorized") ? ["Uncategorized"] : [])];

  const segments: Segment[] = order.map((key, i) => ({
    key,
    label: key,
    count: counts.get(key) ?? 0,
    color: key === "Uncategorized" ? "#c3c2b7" : CATEGORY_PALETTE[key] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
  }));

  return <StackedMeter title="Category" segments={segments} />;
}

export function TopUsageChart({ items }: { items: QuotaItem[] }) {
  const top = [...items].sort((a, b) => usagePercent(b) - usagePercent(a)).slice(0, 10);

  if (top.length === 0) return null;

  return (
    <div className="insight-panel insight-panel-wide">
      <h3 className="insight-title">Top 10 by usage</h3>
      <div className="top-usage-list">
        {top.map((item) => {
          const pct = usagePercent(item);
          const tier = usageTier(pct);
          const label = item.teamName ?? item.teamCode ?? item.teamId;
          return (
            <div className="top-usage-row" key={item.apiKeyId}>
              <span className="top-usage-label" title={label}>
                {label}
              </span>
              <div className="usage-bar" data-level={tier}>
                <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="top-usage-pct">{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
