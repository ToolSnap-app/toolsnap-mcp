/**
 * Fase 25.18 — sirve el panel /analytics en local con un payload de fixture,
 * sin wrangler ni D1 (una carga fria del panel real cuesta ~87 k filas leidas).
 *
 *   npx tsx scripts/panel-preview.ts            # http://127.0.0.1:8798/analytics
 *   PORT=9000 npx tsx scripts/panel-preview.ts
 *
 * Escenarios para probar estados (cookie o query, se recuerda por proceso):
 *   /analytics/data?scenario=ok|problems|empty  · /analytics/data?status=502
 *   /scenario/problems  -> fija el escenario y redirige al panel
 *
 * Los ficheros del panel se leen en cada peticion: editar y recargar.
 */
import "../test/_support/text-modules.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDashboardFixture, type FixtureOptions } from "../test/_support/dashboard-fixture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8798);
let scenario: NonNullable<FixtureOptions["scenario"]> = "ok";
let forcedStatus = 0;

async function panelHtml(): Promise<string> {
  const [html, css, lib, app] = await Promise.all(
    ["panel.html", "panel.css", "panel-lib.js", "panel.js"].map((f) => readFile(join(ROOT, "src/analytics/panel", f), "utf8"))
  );
  const { assemblePanel } = await import("../src/analytics/panel.js");
  return assemblePanel(html, css, lib, app);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/analytics") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(await panelHtml());
      return;
    }
    if (url.pathname.startsWith("/scenario/")) {
      const s = url.pathname.slice("/scenario/".length);
      if (s === "ok" || s === "problems" || s === "empty") { scenario = s; forcedStatus = 0; }
      else if (s === "502" || s === "401" || s === "302") { forcedStatus = Number(s); }
      res.writeHead(302, { location: "/analytics" });
      res.end();
      return;
    }
    if (url.pathname === "/analytics/data") {
      const s = url.searchParams.get("scenario");
      if (s === "ok" || s === "problems" || s === "empty") scenario = s;
      const status = Number(url.searchParams.get("status") || forcedStatus);
      if (status === 302) {
        // Fase 25.20 — lo que hace Cloudflare Access sin sesion: 302 a otro origen.
        // El panel lo pide con redirect:'manual' y recibe un opaqueredirect.
        res.writeHead(302, { location: "https://example.cloudflareaccess.com/cdn-cgi/access/login/" });
        res.end();
        return;
      }
      if (status) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forced " + status }));
        return;
      }
      await new Promise((r) => setTimeout(r, 350)); // latencia visible para ver los esqueletos
      const data = buildDashboardFixture(Date.now(), { scenario, seed: url.searchParams.get("include_internal") === "1" ? 11 : 7 });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/img/") || url.pathname === "/favicon.ico") {
      const file = join(ROOT, "site/public", url.pathname);
      const body = await readFile(file);
      const type = file.endsWith(".woff2") ? "font/woff2" : file.endsWith(".png") ? "image/png" : file.endsWith(".ico") ? "image/x-icon" : "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`panel preview: http://127.0.0.1:${PORT}/analytics  (scenarios: /scenario/ok | /scenario/problems | /scenario/empty | /scenario/502)`);
});
