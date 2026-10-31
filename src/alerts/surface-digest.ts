import type { Env } from "../index.js";
import { getWeeklySurfaceDigest } from "../analytics/queries.js";
import { sendTelegram } from "./telegram.js";

/**
 * Weekly "which surface converts" digest (Fase 24.3) — connections, calls,
 * revenue by MCP client (Claude Desktop, Claude Code, mcp-remote, ...),
 * this week vs last week. Sent Mondays, deduped via KV like the existing
 * screenshot-quota digest in usage-alerts.ts. Safe before configuration:
 * sendTelegram no-ops without bot token + chat id.
 */

const KV_TTL_SEC = 45 * 24 * 60 * 60;

function weekOfMonth(d: Date): number {
  return Math.ceil(d.getUTCDate() / 7);
}

function pctDelta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "(new)" : "";
  const pct = Math.round(((current - previous) / previous) * 100);
  const arrow = pct >= 0 ? "▲" : "▼";
  return `(${arrow}${Math.abs(pct)}%)`;
}

export async function checkSurfaceDigest(env: Env, now: Date = new Date()): Promise<void> {
  if (now.getUTCDay() !== 1) return; // Mondays only

  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const digestKey = `digest:surface:${month}:w${weekOfMonth(now)}`;
  const sent = await env.X402_NONCES.get(digestKey);
  if (sent) return;
  await env.X402_NONCES.put(digestKey, "1", { expirationTtl: KV_TTL_SEC }).catch((err: unknown) => {
    // Fase 25.14 — best-effort: worst case the digest repeats next Monday run.
    console.warn("surface digest KV write failed:", err instanceof Error ? err.message : String(err));
  });

  const d = await getWeeklySurfaceDigest(env.PREPAID_DB, now.getTime());

  const lastByClient = new Map(d.connects_last_week.map((r) => [r.client, r.connects]));
  const connectLines = d.connects_this_week.length
    ? d.connects_this_week
        .map((r) => `  • ${r.client}: *${r.connects}* ${pctDelta(r.connects, lastByClient.get(r.client) ?? 0)}`)
        .join("\n")
    : "  (sin conexiones nuevas esta semana)";

  const callsByClient = d.calls_this_week.length
    ? d.calls_this_week.map((r) => `  • ${r.client}: ${r.calls}`).join("\n")
    : "  (sin llamadas esta semana)";

  const topTools = d.top_tools_this_week.length
    ? d.top_tools_this_week.map((r) => `${r.tool} (${r.calls})`).join(", ")
    : "—";

  const conversionPct =
    d.total_calls_this_week > 0 ? Math.round((d.paid_calls_this_week / d.total_calls_this_week) * 100) : 0;

  const pf = d.paywall_funnel_this_week;
  const paywallPct = pf.hit_payers > 0 ? Math.round((pf.converted_payers / pf.hit_payers) * 100) : 0;

  // Fase 25.3 — directory-listing stats: useCount + week-over-week delta
  // where the source exposes one, presence-only otherwise (Glama), plus a drift warning when a listing description changed since
  // the last daily snapshot — descriptions are hand-edited on each
  // directory's site, so a silent change is worth a look.
  const directoryLines = d.directory_stats.length
    ? d.directory_stats
        .map((r) => {
          const countPart =
            r.use_count !== null
              ? `useCount ${r.use_count} ${pctDelta(r.use_count, r.use_count_7d_ago ?? 0)}`
              : "listed (no usage metric exposed)";
          const driftPart = r.description_changed ? " ⚠ description changed" : "";
          return `  • ${r.source}: ${countPart}${driftPart}`;
        })
        .join("\n")
    : "  (sin snapshots de directorios todavía)";

  // Fase 25.9 — el ruido que el pager ya no manda, resumido aqui una vez por
  // semana. `internal` es la unica cifra que deberia ser cero: es lo que SI
  // pagina, y si no lo es hubo alertas reales esta semana que conviene repasar
  // en el panel. Un `caller` alto concentrado en una tool no es culpa de los
  // agentes: es su esquema explicandose mal.
  const sup = d.suppressed_errors_this_week;
  const supTotal = sup.caller + sup.upstream + sup.internal + sup.probe;

  const msg = [
    `📊 *ToolSnap — resumen semanal de superficie* (${month}, semana ${weekOfMonth(now)})`,
    ``,
    `*Conexiones nuevas por superficie:*`,
    connectLines,
    ``,
    `*Llamadas por superficie:*`,
    callsByClient,
    ``,
    `Llamadas totales: *${d.total_calls_this_week}* ${pctDelta(d.total_calls_this_week, d.total_calls_last_week)} vs semana anterior (${d.total_calls_last_week})`,
    `Revenue: *$${d.total_revenue_this_week.toFixed(4)}*`,
    `Conversión free→paid: *${conversionPct}%* (${d.paid_calls_this_week}/${d.total_calls_this_week})`,
    `Muro de pago → conversión: *${paywallPct}%* (${pf.converted_payers}/${pf.hit_payers} agentes que vieron el 402)`,
    `Top tools: ${topTools}`,
    ``,
    `*Directorios:*`,
    directoryLines,
    ``,
    `*Errores de la semana* (${supTotal} en total, silenciados salvo los internos):`,
    `  • del llamante (mal uso de la tool): ${sup.caller}`,
    `  • del sitio destino: ${sup.upstream}`,
    `  • de escaneres de directorios: ${sup.probe}`,
    `  • *de ToolSnap: ${sup.internal}*${sup.internal > 0 ? " ← estos si avisaron" : " ✅"}`,
  ].join("\n");

  await sendTelegram(env, msg);
}
