# Build context is the repo root (see railway.json / Railway "Root Directory" = /).

FROM oven/bun:1 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

FROM oven/bun:1 AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/package.json backend/bun.lock ./
COPY backend/src ./src
COPY backend/data ./data
COPY --from=frontend-build /app/frontend/dist ./public

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
