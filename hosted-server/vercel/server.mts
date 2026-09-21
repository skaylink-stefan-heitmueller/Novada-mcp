/**
 * server.mts — container entrypoint.
 *
 * Vercel normally supplies the HTTP layer and the `vercel.json` rewrites. In a
 * container we provide both ourselves: a plain `node:http` server that maps the
 * same routes onto the same default-exported Node handlers.
 *
 * Routing parity with vercel.json:
 *   /api/reconcile        -> api/reconcile.ts   (cron endpoint, CRON_SECRET gated)
 *   everything else       -> api/mcp.ts         (handles /, /health, OAuth,
 *                                                /mcp, /:key/mcp, and 404s)
 *
 * CORS is emitted by the handler itself, so no proxy layer is required.
 *
 * Env: PORT (default 8080), HOST (default 0.0.0.0), SHUTDOWN_GRACE_MS
 * (default 25000). All other configuration is the same set of env vars the
 * Vercel deployment uses — see README.
 */
import { createServer } from "node:http";
import mcpHandler from "./api/mcp.js";
import reconcileHandler from "./api/reconcile.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
// Drain budget. Must stay BELOW the orchestrator's kill grace, or the process is
// SIGKILLed mid-drain: `docker stop -t` (default 10s) or Kubernetes
// terminationGracePeriodSeconds (default 30s). Tool calls on this surface are
// budgeted up to FUNCTION_MAX_DURATION_S = 300s in api/mcp.ts, so a call can
// always outlive any realistic grace period — the cap bounds that worst case
// instead of hanging forever.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

/** Set on first shutdown signal: stop taking new work, keep serving in-flight. */
let draining = false;

const server = createServer(async (req, res) => {
  // Narrow safety net. Once draining starts, the listener is closed (new
  // connections are refused) and idle keep-alive sockets are dropped, so almost
  // nothing reaches here. What can: a socket that was mid-request when the
  // signal arrived and then pipelines another request on the same connection.
  // Refuse those so they cannot keep extending the drain window.
  // Readiness is handled by the refused connection, not by this response — a
  // probe against a draining instance fails to connect at all.
  if (draining) {
    res.statusCode = 503;
    res.setHeader("connection", "close");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "SHUTTING_DOWN",
      message: "Server is shutting down. Retry — another instance can serve this.",
    }));
    return;
  }

  const pathname = (req.url ?? "/").split("?")[0];
  try {
    if (pathname === "/api/reconcile" || pathname === "/reconcile") {
      await reconcileHandler(req, res);
    } else {
      await mcpHandler(req, res);
    }
  } catch (err) {
    // The handlers own their error responses; this is a last-resort net so a
    // throw can never leave the socket hanging.
    console.error("[server] unhandled handler error:", (err as Error)?.message ?? String(err));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[server] novada-mcp hosted listening on http://${HOST}:${PORT}/mcp`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Node is PID 1 here (exec-form CMD), so the default SIGTERM disposition is
// "ignore" — without these handlers `docker stop` would always fall through to
// SIGKILL after its grace period.
let shuttingDown = false;

function shutdown(signal: string): void {
  // A second signal means the operator is out of patience — leave immediately.
  if (shuttingDown) {
    console.warn(`[server] ${signal} again while draining — exiting now`);
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  }
  shuttingDown = true;
  draining = true;
  console.log(`[server] ${signal} received, draining for up to ${SHUTDOWN_GRACE_MS}ms`);

  let hardStop: NodeJS.Timeout | undefined;

  // Stops the listener and waits for active requests; the callback fires once
  // the last one is done.
  server.close(() => {
    if (hardStop) clearTimeout(hardStop);
    console.log("[server] drained cleanly");
    process.exit(0);
  });

  // Release sockets parked between requests right away. Node 22's close() also
  // does this, but calling it explicitly keeps the behavior pinned rather than
  // relying on a version-dependent detail.
  server.closeIdleConnections();

  hardStop = setTimeout(() => {
    console.warn(`[server] drain exceeded ${SHUTDOWN_GRACE_MS}ms, closing active connections`);
    // Send a real FIN to whatever is still attached instead of letting the
    // process die under them, which would surface as a connection reset.
    server.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  // Don't let the timer itself hold the event loop open.
  hardStop.unref();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => shutdown(signal));
}
