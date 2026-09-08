import type { EnrichedQuotaItem } from "./quotaService";

const MAX_MESSAGE_CHARS = 3500;

function usagePercent(item: EnrichedQuotaItem): number {
  if (item.tokenLimit <= 0) return 0;
  return Math.min(100, (item.usedTokens / item.tokenLimit) * 100);
}

function isExceeded(item: EnrichedQuotaItem): boolean {
  return item.tokenLimit > 0 && item.usedTokens >= item.tokenLimit;
}

const MAX_NAME_WIDTH = 24;

function label(item: EnrichedQuotaItem): string {
  return item.teamCode ?? item.teamId;
}

function nameLabel(item: EnrichedQuotaItem): string {
  const name = item.teamName ?? "—";
  return name.length > MAX_NAME_WIDTH ? `${name.slice(0, MAX_NAME_WIDTH - 1)}…` : name;
}

function formatLine(item: EnrichedQuotaItem, nameWidth: number): string {
  const pct = usagePercent(item).toFixed(0);
  return `${label(item).padEnd(12)} ${nameLabel(item).padEnd(nameWidth)} ${item.usedTokens.toLocaleString()} / ${item.tokenLimit.toLocaleString()} (${pct}%)`;
}

function chunkLines(lines: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;

  for (const line of lines) {
    if (current.length > 0 && length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function sectionMessages(title: string, items: EnrichedQuotaItem[]): string[] {
  if (items.length === 0) {
    return [`*${title} (0)*\n_none_`];
  }

  const sortedItems = items.slice().sort((a, b) => b.usedTokens - a.usedTokens);
  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(...sortedItems.map((item) => nameLabel(item).length)));
  const lines = sortedItems.map((item) => formatLine(item, nameWidth));

  const chunks = chunkLines(lines, MAX_MESSAGE_CHARS);
  return chunks.map((chunk, i) => {
    const heading = chunks.length > 1 ? `*${title} (${items.length}) — part ${i + 1}/${chunks.length}*` : `*${title} (${items.length})*`;
    return `${heading}\n\`\`\`${chunk.join("\n")}\`\`\``;
  });
}

/**
 * Builds the sequence of Slack messages for the daily report: a header,
 * then teams over quota, then teams actively consuming tokens (idle
 * teams with zero usage are omitted as noise).
 */
export function buildDailyReportMessages(items: EnrichedQuotaItem[]): string[] {
  const exceeded = items.filter(isExceeded);
  const active = items.filter((item) => !isExceeded(item) && item.usedTokens > 0);
  const idleCount = items.length - exceeded.length - active.length;

  const header = [
    `*Daily Token Quota Report* — ${new Date().toDateString()}`,
    `${items.length} teams total, ${idleCount} with no usage yet`,
  ].join("\n");

  return [
    header,
    ...sectionMessages("Exceeded quota", exceeded),
    ...sectionMessages("Active usage", active),
  ];
}
