/**
 * Local dashboard. Binds to 127.0.0.1 only: never reachable from the network.
 *
 *   GET  /            the page
 *   GET  /desk        the live signal desk
 *   GET  /board       the meme-coin board: launched -> quick test -> buy early / dip hunt -> sell
 *   GET  /api/desk    entries, setups, movers, majors plans, scorecard
 *   GET  /api/state   everything the page shows
 *   POST /api/halt    emergency stop: flattens every open paper position (the
 *                     exit engine treats a KILL halt as "close everything") and
 *                     blocks new entries for the rest of the UTC day. It never
 *                     clears itself.
 *
 * The halt is the one action here, so it is guarded against a page on another
 * site posting to localhost: the Origin and Host headers must name this server
 * and the request must carry a per-process token the page received.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { Logger } from "../core/log.ts";
import { deskState, type DeskDeps } from "./desk.ts";
import { dashboardState, type DashboardDeps } from "./state.ts";

export const HALT_REASON = "KILL: manual stop from dashboard";

export function startDashboard(deps: DashboardDeps & { desk?: DeskDeps }, logger: Logger, port = 4777): Server {
  const token = randomBytes(16).toString("hex");
  const template = readFileSync(resolve(import.meta.dirname, "page.html"), "utf8");
  const html = template.replace('<html lang="en">', `<html lang="en" data-halt-token="${token}">`);
  const deskHtml = readFileSync(resolve(import.meta.dirname, "desk.html"), "utf8");
  const boardHtml = readFileSync(resolve(import.meta.dirname, "board.html"), "utf8");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/api/state") {
        const body = JSON.stringify(dashboardState(deps), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/desk") {
        const body = JSON.stringify(deps.desk ? deskState(deps.desk) : { error: "desk not enabled: start with --signals" }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/board") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(boardHtml);
        return;
      }
      if (req.method === "GET" && url.pathname === "/desk") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(deskHtml);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/halt") {
        const self = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const host = req.headers.host ?? "";
        const origin = req.headers.origin ?? "";
        const sent = req.headers["x-halt-token"];
        const ok = host === `127.0.0.1:${(server.address() as { port: number }).port}` && origin === self && sent === token;
        if (!ok) {
          logger.warn("dashboard halt refused", { host, origin: origin || "none", tokenMatch: sent === token });
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ halted: false, error: "refused: not from this dashboard page" }));
          return;
        }
        deps.riskState.halt(HALT_REASON);
        logger.error("MANUAL HALT from dashboard: open positions will be closed; new entries blocked for the rest of the UTC day");
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
