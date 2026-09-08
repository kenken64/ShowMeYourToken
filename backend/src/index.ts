import { join, normalize, sep } from "node:path";
import { scanTable, TABLE_NAME } from "./dynamo";
import { getTeamInfo } from "./teamDirectory";

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
        const items = await scanTable();
        const enriched = items.map((item) => {
          const teamId = item.teamId;
          const info = typeof teamId === "string" ? getTeamInfo(teamId) : undefined;
          return {
            ...item,
            teamCode: info?.teamCode ?? null,
            teamName: info?.teamName ?? null,
            category: info?.category ?? null,
          };
        });
        return json({ items: enriched, count: enriched.length });
      } catch (err) {
        console.error("DynamoDB scan failed:", err);
        return json({ error: "Failed to fetch data from DynamoDB" }, 500);
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
