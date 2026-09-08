import { join, normalize, sep } from "node:path";
import { TABLE_NAME } from "./dynamo";
import { getEnrichedQuota } from "./quotaService";
import { getMonthToDateCost } from "./costExplorer";
import { sendDailyReport } from "./dailyReport";
import { startDailyScheduler } from "./scheduler";

const PORT = Number(process.env.PORT ?? 4000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    return null;
  }
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }
  return null;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, table: TABLE_NAME });
    }

    if (url.pathname === "/api/quota" && req.method === "GET") {
      try {
        const items = await getEnrichedQuota();
        return json({ items, count: items.length });
      } catch (err) {
        console.error("DynamoDB scan failed:", err);
        return json({ error: "Failed to fetch data from DynamoDB" }, 500);
      }
    }

    if (url.pathname === "/api/billing" && req.method === "GET") {
      try {
        const billing = await getMonthToDateCost();
        return json(billing);
      } catch (err) {
        console.error("Cost Explorer fetch failed:", err);
        return json({ error: "Failed to fetch billing data" }, 500);
      }
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const asset = await serveStatic(url.pathname === "/" ? "/index.html" : url.pathname);
      if (asset) return asset;

      const indexFallback = await serveStatic("/index.html");
      if (indexFallback) return indexFallback;
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`Backend running at http://localhost:${PORT} (table: ${TABLE_NAME})`);

if (process.env.SLACK_WEBHOOK_URL) {
  const hours = (process.env.SLACK_REPORT_HOURS ?? "9")
    .split(",")
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  const timeZone = process.env.SLACK_REPORT_TZ ?? "Asia/Singapore";
  for (const hour of hours) {
    startDailyScheduler(hour, timeZone, sendDailyReport);
  }
} else {
  console.log("SLACK_WEBHOOK_URL not set; daily Slack report disabled");
}
