# ShowMeYourAgent Token Quota

A dashboard for the NUS-ISS ShowMeYourAgent programme that shows each team's LLM token usage against their quota. A Bun backend reads usage data from DynamoDB and serves it to a React frontend that lists teams sorted by usage, split into "Has Quota" and "Exceeded" tabs, with search and pagination.

## Architecture

```
frontend/  React 19 + Vite + TypeScript SPA
backend/   Bun HTTP server (no framework) — reads a DynamoDB table and serves the API + built frontend
bundle/    Dockerfile that builds both and runs the backend as a single container
```

In production the backend serves the built frontend as static files and exposes the API under `/api/*`; there's no separate frontend server.

## Prerequisites

- [Bun](https://bun.sh) (v1+)
- An AWS account with a DynamoDB table containing team quota records, plus credentials with read access to it

## Backend

```bash
cd backend
cp .env.example .env   # fill in AWS credentials
bun install
bun run dev             # bun --watch run src/index.ts
```

Environment variables (`backend/.env`):

| Variable | Description | Default |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | AWS access key (required) | — |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (required) | — |
| `AWS_REGION` | AWS region (required) | — |
| `TABLE_NAME` | DynamoDB table to scan | `LLMTeamQuota` |
| `PORT` | HTTP port | `4000` |
| `CORS_ORIGIN` | Allowed CORS origin for the API | `http://localhost:5173` |

Expected DynamoDB item shape (one row per team/API key):

```ts
{
  teamId: string;
  apiKeyId: string;
  tokenLimit: number;
  usedTokens: number;
  reservedTokens: number;
  status: string;
}
```

### Team directory (`backend/data/API_Team_Code_Mapping.xlsx`)

`backend/src/teamDirectory.ts` loads this spreadsheet once at startup and builds an in-memory lookup keyed on its `api_key_name` column, which matches DynamoDB's `teamId` (e.g. `hack-team-008`). The `/api/quota` response is enriched with the matching `Team Code`, `Team Name`, and `Category` columns; teams with no match in the spreadsheet get `null` for these fields. To update the mapping, replace the xlsx file and restart the backend.

### API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check; returns `{ ok, table }` |
| `GET` | `/api/quota` | Scans the DynamoDB table (paginating through `LastEvaluatedKey`), joins each item against the team directory, and returns `{ items, count }` where each item also has `teamCode`, `teamName`, and `category` |
| `PUT` | `/api/admin/quota` | Bulk-updates `tokenLimit`s; requires `Authorization: Bearer $ADMIN_TOKEN`. See "Admin bulk token-limit update" below |
| `PUT` | `/api/admin/status` | Enables or disables one or many teams; requires `Authorization: Bearer $ADMIN_TOKEN`. See "Admin team usage controls" below |

Any other `GET` request is served from `backend/public` (the built frontend), falling back to `index.html` for client-side routing.

### Admin bulk token-limit update

`PUT /api/admin/quota` lets an admin update one or many teams' `tokenLimit` in a single request, authenticated by a shared Bearer token (`ADMIN_TOKEN`) compared with a timing-safe check (`backend/src/adminQuota.ts`). Leave `ADMIN_TOKEN` unset to disable the endpoint.

Each team has a **daily increase allowance** of `ADMIN_DAILY_LIMIT` (default 2,000,000) over a rolling 24h window: increases to `tokenLimit` consume from it atomically (tracked in the `LLMReportLock` table as `quota-allowance#<apiKeyId>` items), while decreases are always allowed and consume nothing. Requests are validated before anything is written: bad shapes, duplicate `apiKeyId`s, or unknown keys (checked via `BatchGetItem` on the table's `apiKeyId` partition key) abort the whole batch. Per-key results are returned (`updated` / `exceeded` / `conflict`), the quota cache is invalidated, and every outcome posts an audit message to Slack with the team code and name.

```bash
curl -X PUT http://localhost:4000/api/admin/quota \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "updates": [
    { "apiKeyId": "key-abc", "tokenLimit": 1500000 },
    { "apiKeyId": "key-def", "tokenLimit": 2000000 }
  ] }'
```

| Variable | Description | Default |
|---|---|---|
| `ADMIN_TOKEN` | Shared Bearer token for `PUT /api/admin/quota`; unset = endpoint disabled | — |
| `ADMIN_DAILY_LIMIT` | Per-team daily `tokenLimit` increase allowance (rolling 24h) | `2000000` |

### Admin team usage controls

The admin page loads each team's **Usage enabled** checkbox from DynamoDB: `ACTIVE` is checked; every other status is unchecked. Enabled teams always appear before disabled teams, including staged checkbox changes, regardless of the selected sort column or direction. Change individual checkboxes, select teams across pages and use **Enable selected** / **Disable selected**, or use **Enable all teams** / **Disable all teams**. The header selection checkbox selects every matching team across all pages, including search results. The all-team action buttons always target the complete team list, regardless of search.

Usage changes are staged until **Apply usage changes** is clicked. They save independently from token-limit changes and do not consume the daily increase allowance. Successful updates refresh the cached quota data; if some writes fail, the page reports those teams and retains their pending usage changes for retry.

`PUT /api/admin/status` accepts up to 500 unique keys per request and validates the entire batch, including unknown keys, before writing. Each update changes only `status`, preserving `tokenLimit`, `usedTokens`, and `reservedTokens`. It returns per-key results and logs an admin audit to Slack. If a write fails mid-batch, successful changes remain applied and the response is HTTP 422 with details.

```json
{
  "updates": [
    { "apiKeyId": "key-abc", "status": "ACTIVE" },
    { "apiKeyId": "key-def", "status": "DISABLED" }
  ]
}
```

The deployed `llm-gateway` Lambda already checks `LLMTeamQuota.status` using consistent reads and requires `ACTIVE` before reserving tokens and calling Bedrock. Disabled teams receive HTTP 403 with `Team access is not active`. Requests already reserved or running may finish. No Lambda change is required.

Run the admin status regression tests with `cd backend && bun test`. They mock DynamoDB and disable Slack, so they do not change live team records or send messages.

### Daily Slack quota report

If `SLACK_WEBHOOK_URL` is set, the backend posts a daily report to that [Slack Incoming Webhook](https://api.slack.com/messaging/webhooks) at each hour listed in `SLACK_REPORT_HOURS` (local time in `SLACK_REPORT_TZ`), split into an "Exceeded quota" and an "Active usage" section (teams with zero usage are omitted). The scheduler (`backend/src/scheduler.ts`) runs in-process — no external cron needed — and re-schedules itself after each run.

| Variable | Description | Default |
|---|---|---|
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL; leave unset to disable the report | — |
| `SLACK_REPORT_HOURS` | Comma-separated 24h local hours to post, e.g. `9,23` | `9` |
| `SLACK_REPORT_TZ` | IANA timezone for `SLACK_REPORT_HOURS` | `Asia/Singapore` |
| `LOCK_TABLE_NAME` | DynamoDB table used to de-duplicate scheduled reports across processes | `LLMReportLock` |

Each scheduled run claims a lock item (`daily-report#<date>#<hour>`) in the lock table with a 1-hour TTL before posting; other processes that lose the race skip the send. This makes the report safe to run from multiple backend replicas. The table must have a `lockId` (String) partition key and TTL enabled on `expiresAt`.

Test it on demand without waiting for the schedule:

```bash
cd backend
bun run report:slack:test
```

## Frontend

```bash
cd frontend
bun install
bun run dev       # starts Vite dev server on :5173
```

Set `VITE_API_BASE` in `frontend/.env` to point at the backend (e.g. `http://localhost:4000`); it's prefixed to all API calls (see `frontend/src/api.ts`). Leave it empty to call the API on the same origin (used in production, since the backend serves the built assets).

Other scripts:

```bash
bun run build     # tsc -b && vite build -> frontend/dist
bun run lint      # oxlint
bun run preview   # preview the production build locally
```

## Running the full stack locally

```bash
# terminal 1
cd backend && bun run dev

# terminal 2
cd frontend && bun run dev
```

Visit `http://localhost:5173`.

## Deployment

The repo ships a multi-stage `bundle/Dockerfile` that:

1. Builds the frontend (`frontend/dist`)
2. Installs production backend dependencies
3. Copies both into a slim Bun runtime image and runs the backend, which serves the frontend build as static assets alongside the `/api/*` routes

`railway.json` configures [Railway](https://railway.com) to build from `bundle/Dockerfile` with the repo root as build context. To build/run it yourself:

```bash
docker build -f bundle/Dockerfile -t showmeyouragent-quota .
docker run -p 3000:3000 \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e AWS_REGION=ap-southeast-1 \
  -e TABLE_NAME=LLMTeamQuota \
  showmeyouragent-quota
```
