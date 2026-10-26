/**
 * Local dashboard. Binds to 127.0.0.1 only: never reachable from the network.
 *
 *   GET  /            the page
 *   GET  /api/state   everything the page shows
 *   POST /api/halt    manual emergency stop: halts NEW ENTRIES for the rest of
 *                     the UTC day. It never closes positions and never clears.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { Logger } from "../core/log.ts";
import { dashboardState, type DashboardDeps } from "./state.ts";

export function startDashboard(deps: DashboardDeps, logger: Logger, port = 4777): Server {
  const html = readFileSync(resolve(import.meta.dirname, "page.html"), "utf8");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/api/state") {
        const body = JSON.stringify(dashboardState(deps), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/halt") {
        deps.riskState.halt("KILL: manual stop from dashboard");
        logger.error("MANUAL HALT from dashboard: new entries blocked for the rest of the UTC day");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ halted: true }));
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      logger.warn("dashboard request failed", { err: (e as Error).message });
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, "127.0.0.1", () => logger.info("dashboard", { url: `http://127.0.0.1:${port}` }));
  return server;
}
