# syntax=docker/dockerfile:1

# Pinned once and reused for both the scanner image and the provenance marker, so
# a scan result stays reproducible and the recorded version cannot drift from the
# binary that produced it. Also removes the `trivy --version | head | cut`
# pipeline the marker used to need (hadolint DL4006).
ARG TRIVY_VERSION=0.74.0

# ─── Stage 1: production dependencies only ───────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Stage 2: build (needs devDependencies for tsc) ─────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY api/ ./api/
COPY vendor/ ./vendor/
COPY server.mts ./
# Emits dist/, then copies the two non-TS inputs tsc does not touch:
# api/_polyfills.js (plain JS, side-effect import) and the prebuilt vendor/ tree.
RUN npm run build

# ─── Stage 3: vulnerability scan of exactly what ships ──────────────────────
FROM aquasec/trivy:${TRIVY_VERSION} AS scan
# Re-declared: a pre-FROM ARG is visible to FROM lines only, not inside a stage.
ARG TRIVY_VERSION
WORKDIR /scan
# Copy only the artifacts the runtime stage receives, so the scanned surface is
# identical to the shipped one: prod-only node_modules, the compiled output, and
# the manifest. devDependencies and the vendor/ sources are deliberately absent.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Override at build time, e.g. --build-arg TRIVY_EXIT_CODE=0 for report-only,
# or --build-arg TRIVY_SEVERITY=CRITICAL to gate on criticals alone.
ARG TRIVY_SEVERITY=HIGH,CRITICAL
ARG TRIVY_EXIT_CODE=1
# Set true to scan strictly from the cached DB (air-gapped builds, or to pin a
# scan to a known DB). Fails if the cache is cold instead of reaching out.
ARG TRIVY_SKIP_DB_UPDATE=false
# The vulnerability DB is ~1.4 GB, so it gets a BuildKit cache mount rather than
# being re-downloaded per build. Notes on the three mount options:
#   id       — stable cache identity, so changing --cache-dir below does not
#              orphan the existing cache (the default id is the target path).
#   sharing=locked — the DB is one big file store; parallel CI builds sharing it
#              in the default `shared` mode can race on the update write.
#   --cache-dir — set explicitly rather than relying on the image's HOME, which
#              is what resolves trivy's /root/.cache/trivy default.
# A warm cache is reused until trivy's own metadata.json NextUpdate expires
# (~24h), so only the first build of a day pays the download.
# Caveat: `docker build --no-cache` and `--no-cache-filter scan` bypass cache
# mounts, so those force a fresh DB download — that is also how you refresh it.
# `rootfs`, not `filesystem`: the fs scanner only reads lock files, and we
# deliberately do not ship package-lock.json (it lists devDependencies too).
# rootfs enables the installed-package analyzer, which walks the actual
# node_modules/*/package.json tree — i.e. the code that really ships.
# The marker file is written only on a clean scan — the runtime stage copies it,
# which is what makes this stage a hard dependency rather than a skippable leaf.
RUN --mount=type=cache,id=trivy-db,target=/var/cache/trivy,sharing=locked \
    trivy rootfs \
      --cache-dir /var/cache/trivy \
      --skip-db-update="${TRIVY_SKIP_DB_UPDATE}" \
      --scanners vuln \
      --severity "${TRIVY_SEVERITY}" \
      --exit-code "${TRIVY_EXIT_CODE}" \
      --no-progress \
      --format table \
      . \
 && printf 'scanned by trivy %s at %s (severity=%s)\n' \
      "${TRIVY_VERSION}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "${TRIVY_SEVERITY}" > /scan/.trivy-ok

# ─── Stage 4: runtime ────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Hosted-surface parity: vendor/novada-mcp/config.js keys isHostedEnvironment()
# off VERCEL/VERCEL_ENV, which gates the Node-only tools. Same flag the
# local-harness sets. Without it the container advertises a different surface
# than the Vercel deployment.
ENV VERCEL=1

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Provenance only (tool version + timestamp, no findings). Its real purpose is
# the build-graph edge: without it BuildKit would prune the scan stage.
COPY --from=scan  /scan/.trivy-ok ./.trivy-ok

# Run unprivileged. Numeric rather than `node` so the identity resolves without
# the image's /etc/passwd — what Kubernetes runAsNonRoot expects (hadolint DL3066).
USER 1000:1000

EXPOSE 8080

# /health needs neither auth nor KV, so it is a true liveness signal.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.mjs"]
