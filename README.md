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

### API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check; returns `{ ok, table }` |
| `GET` | `/api/quota` | Scans the DynamoDB table (paginating through `LastEvaluatedKey`) and returns `{ items, count }` |

Any other `GET` request is served from `backend/public` (the built frontend), falling back to `index.html` for client-side routing.

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
