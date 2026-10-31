/**
 * Fase 25.18 — fixture realista de DashboardData para probar el panel sin
 * tocar D1 (la cuota diaria de filas leidas se agoto el 2026-10-20 y una carga
 * fria del panel cuesta ~87 k filas). Genera ~30 dias de eventos sinteticos con
 * un generador determinista y deriva de ellos TODAS las vistas del payload, de
 * modo que los cortes 24h/7d/30d, el embudo y la fila de COGS son coherentes
 * entre si, igual que en produccion.
 *
 * Lo usan scripts/panel-preview.ts (servidor local del panel) y los tests.
 */
import type { DashboardData, WindowKey, WindowStats } from "../../src/analytics/queries.js";
import { cogsList, type ToolCogsRow } from "../../src/analytics/cogs.js";

const DAY = 86400000;
const HALF_HOUR = 1800000;

/** mulberry32: determinista, suficiente para un fixture. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ev {
  ts: number;
  tool: string;
  type: string;
  client: string;
  probe: boolean;
  payer: string;
  revenue: number;
  latency: number;
  cogs: number | null;
  detail: string | null;
  cls: "internal" | "upstream" | "caller";
}

const TOOLS: Array<[string, number, number]> = [
  // nombre, peso, latencia media ms
  ["fetch_extract", 30, 900],
  ["html_to_markdown", 14, 700],
  ["fetch_metadata", 10, 500],
  ["sitemap_parse", 7, 1200],
  ["screenshot_url", 6, 3200],
  ["pdf_text_extract", 6, 1800],
  ["csv_query", 5, 400],
  ["json_query", 5, 300],
  ["keyword_research", 4, 2400],
  ["rss_parse", 4, 600],
  ["link_check", 3, 2600],
  ["image_generate", 2, 6500],
  ["remove_background", 2, 4100],
  ["tool_catalog", 2, 120],
];
const COGS_TOOLS = new Set(["screenshot_url", "keyword_research", "remove_background", "image_generate"]);
const CLIENTS: Array<[string, number, boolean]> = [
  ["claude-ai", 34, false],
  ["cursor", 18, false],
  ["claude-code", 14, false],
  ["openai-agents", 8, false],
  ["Hermes", 6, false],
  ["smithery-scanner", 9, true],
  ["glama-crawler", 6, true],
  ["mcp-inspector", 3, false],
  ["fixter-monitoring", 2, true],
];

function pick<T>(r: () => number, items: Array<[T, number, ...unknown[]]>): [T, number, ...unknown[]] {
  const total = items.reduce((s, it) => s + it[1], 0);
  let x = r() * total;
  for (const it of items) {
    x -= it[1];
    if (x <= 0) return it;
  }
  return items[items.length - 1];
}

export function buildEvents(now: number, seed = 7): Ev[] {
  const r = rng(seed);
  const out: Ev[] = [];
  const since = now - 30 * DAY;
  // volumen: ~45 llamadas/dia con mas actividad en horas europeas y un repunte la ultima semana
  for (let t = since; t < now; t += HALF_HOUR) {
    const hour = new Date(t).getUTCHours();
    const dayFactor = 0.6 + 0.4 * Math.sin(((t - since) / (30 * DAY)) * Math.PI);
    const hourFactor = hour >= 7 && hour <= 22 ? 1.2 : 0.35;
    const lambda = 0.95 * dayFactor * hourFactor * (t > now - 7 * DAY ? 1.45 : 1);
    let n = 0;
    for (let k = 0; k < 6; k++) if (r() < lambda / 6) n++;
    for (let i = 0; i < n; i++) {
      const [tool, , lat] = pick(r, TOOLS) as [string, number, number];
      const [client, , probe] = pick(r, CLIENTS) as [string, number, boolean];
      const ts = t + Math.floor(r() * HALF_HOUR);
      const paid = COGS_TOOLS.has(tool) || r() < 0.22;
      let type = "free_tool";
      let revenue = 0;
      let payer = "anon:" + Math.floor(r() * 60).toString(16).padStart(8, "a");
      let detail: string | null = null;
      let cls: Ev["cls"] = "caller";
      const fail = r();
      if (paid) {
        const rail = r();
        if (rail < 0.3) { type = "402_rejected"; detail = "no_payment_payload"; }
        else if (rail < 0.6) { type = "x402_paid"; revenue = tool === "keyword_research" ? 0.04 : tool === "remove_background" ? 0.03 : tool === "image_generate" ? 0.024 : 0.02; payer = "0x" + Math.floor(r() * 1e12).toString(16).padStart(40, "7"); }
        else if (rail < 0.85) { type = "prepaid"; revenue = tool === "keyword_research" ? 0.025 : tool === "remove_background" ? 0.02 : tool === "image_generate" ? 0.012 : 0.01; payer = "acct:" + Math.floor(r() * 12).toString().padStart(8, "0") + "-4e1b-8c2a-9f30-2c6d1a7b5e90"; }
        else { type = "api_key"; revenue = 0.01; payer = "key:" + Math.floor(r() * 5).toString().padStart(6, "0"); }
      }
      if (type !== "402_rejected" && fail < 0.07) {
        type = "tool_error";
        revenue = 0;
        if (fail < 0.01) { cls = "internal"; detail = "TypeError: cannot read properties of undefined (reading 'url')"; }
        else if (fail < 0.045) { cls = "upstream"; detail = "upstream HTTP 503 from target site"; }
        else { cls = "caller"; detail = "`url` is required (non-empty string)"; }
      }
      const executed = ["free_tool", "x402_paid", "prepaid", "api_key", "oauth", "x402_free_first"].includes(type);
      const cogs = executed && tool === "image_generate" ? 0.012 : null;
      out.push({ ts, tool, type, client, probe, payer, revenue, latency: Math.round(lat * (0.5 + r())), cogs, detail, cls });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

function windowStats(evs: Ev[], since: number): WindowStats {
  const w = evs.filter((e) => e.ts >= since);
  const real = w.filter((e) => !e.probe);
  const executed = real.filter((e) => ["free_tool", "x402_paid", "prepaid", "api_key"].includes(e.type));
  const count = <K extends string>(items: Ev[], key: (e: Ev) => K): Array<Record<"calls", number> & Record<K, string>> => {
    const m = new Map<string, number>();
    items.forEach((e) => m.set(key(e), (m.get(key(e)) ?? 0) + 1));
    return Array.from(m.entries()).map(([k, calls]) => ({ [key.name || "k"]: k, calls }) as never).sort((a: { calls: number }, b: { calls: number }) => b.calls - a.calls);
  };
  void count;
  const byTool = new Map<string, Ev[]>();
  real.forEach((e) => byTool.set(e.tool, [...(byTool.get(e.tool) ?? []), e]));
  const top_tools = Array.from(byTool.entries()).map(([tool, es]) => ({ tool, calls: es.length })).sort((a, b) => b.calls - a.calls).slice(0, 10);
  const payMap = new Map<string, number>();
  real.forEach((e) => {
    const t = e.type === "402_rejected" ? "402_no_wallet" : e.type;
    payMap.set(t, (payMap.get(t) ?? 0) + 1);
  });
  const payment_breakdown = Array.from(payMap.entries()).map(([type, calls]) => ({ type, calls })).sort((a, b) => b.calls - a.calls);
  const clientMap = new Map<string, { client: string; calls: number; probe: boolean }>();
  w.forEach((e) => {
    const k = e.client + "|" + e.probe;
    const row = clientMap.get(k) ?? { client: e.client, calls: 0, probe: e.probe };
    row.calls++;
    clientMap.set(k, row);
  });
  const error_rate_by_tool = Array.from(byTool.entries()).map(([tool, es]) => {
    const errs = es.filter((e) => e.type === "tool_error");
    const our = errs.filter((e) => e.cls === "internal").length;
    const up = errs.filter((e) => e.cls === "upstream").length;
    const caller = errs.filter((e) => e.cls === "caller").length;
    return { tool, total: es.length, errors: errs.length, our_errors: our, upstream_errors: up, caller_errors: caller, muted_errors: 0, error_pct: es.length ? Math.round((errs.length / es.length) * 100) : 0 };
  }).filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors);
  const lat = executed.map((e) => e.latency);
  const latency_by_tool = Array.from(byTool.entries()).map(([tool, es]) => {
    const ls = es.filter((e) => e.type !== "402_rejected").map((e) => e.latency);
    return { tool, calls: ls.length, p50_latency_ms: percentile(ls, 0.5), p95_latency_ms: percentile(ls, 0.95) };
  }).sort((a, b) => b.calls - a.calls).slice(0, 10);
  const hitPayers = new Set(real.filter((e) => e.type === "402_rejected").map((e) => e.payer));
  const paidPayers = new Set(real.filter((e) => e.revenue > 0).map((e) => e.payer));
  const converted = Array.from(hitPayers).filter((p, i) => i % 4 === 0 || paidPayers.has(p)).length;
  const cogsRows: ToolCogsRow[] = Array.from(byTool.entries()).map(([tool, es]) => {
    const ex = es.filter((e) => ["free_tool", "x402_paid", "prepaid", "api_key"].includes(e.type));
    const g = ex.reduce((s, e) => s + (e.cogs ?? 0), 0);
    return { tool, e30: ex.length, e7: ex.length, e1: ex.length, g30: g, g7: g, g1: g };
  });
  return {
    calls: real.length,
    revenue: Math.round(real.reduce((s, e) => s + e.revenue, 0) * 1e6) / 1e6,
    unique_payers: new Set(real.filter((e) => !e.payer.startsWith("anon")).map((e) => e.payer)).size,
    unique_anon_agents: new Set(real.filter((e) => e.payer.startsWith("anon")).map((e) => e.payer)).size,
    avg_latency_ms: lat.length ? Math.round(lat.reduce((s, v) => s + v, 0) / lat.length) : 0,
    p50_latency_ms: percentile(lat, 0.5),
    p95_latency_ms: percentile(lat, 0.95),
    top_tools,
    payment_breakdown,
    calls_by_client: Array.from(clientMap.values()).sort((a, b) => b.calls - a.calls),
    paywall_funnel: { hit_payers: hitPayers.size, converted_payers: Math.min(hitPayers.size, converted) },
    error_rate_by_tool,
    latency_by_tool,
    cogs: cogsList(cogsRows, "30"),
  };
}

export interface FixtureOptions {
  /** "ok" (por defecto) | "problems" (tool rota + cron fallando + silencio) | "empty" (sin eventos). */
  scenario?: "ok" | "problems" | "empty";
  seed?: number;
}

export function buildDashboardFixture(now = Date.now(), opts: FixtureOptions = {}): DashboardData {
  const scenario = opts.scenario ?? "ok";
  const evs = scenario === "empty" ? [] : buildEvents(now, opts.seed);
  const real = evs.filter((e) => !e.probe);

  // series diarias (365 d): los 30 d sinteticos + una cola plana mas antigua
  const byDay = new Map<string, { calls: number; revenue: number }>();
  real.forEach((e) => {
    const d = byDay.get(dayKey(e.ts)) ?? { calls: 0, revenue: 0 };
    d.calls++;
    d.revenue += e.revenue;
    byDay.set(dayKey(e.ts), d);
  });
  const r = rng((opts.seed ?? 7) + 99);
  if (scenario !== "empty") {
    for (let i = 31; i <= 110; i++) {
      const k = dayKey(now - i * DAY);
      const calls = Math.round(8 + r() * 14);
      byDay.set(k, { calls, revenue: Math.round(calls * 0.16 * r() * 100) / 100 });
    }
  }
  if (scenario !== "empty") {
    // Fase 25.21: el dia UTC en curso llega a medias; con pocas llamadas el panel debe
    // dibujarlo como parcial en vez de como un precipicio.
    const today = byDay.get(dayKey(now)) ?? { calls: 0, revenue: 0 };
    const calls = Math.min(today.calls, 3);
    byDay.set(dayKey(now), { calls, revenue: today.calls ? Math.round(today.revenue * (calls / today.calls) * 100) / 100 : 0 });
  }
  const days = Array.from(byDay.keys()).sort();
  const calls_by_day = days.map((day) => ({ day, calls: byDay.get(day)!.calls }));
  const revenue_by_day = days.map((day) => ({ day, revenue: Math.round(byDay.get(day)!.revenue * 1e6) / 1e6 }));

  const hh = new Map<number, { calls: number; revenue: number }>();
  real.filter((e) => e.ts >= now - 7 * DAY).forEach((e) => {
    const b = Math.floor(e.ts / HALF_HOUR) * HALF_HOUR;
    const d = hh.get(b) ?? { calls: 0, revenue: 0 };
    d.calls++;
    d.revenue += e.revenue;
    hh.set(b, d);
  });
  const hhKeys = Array.from(hh.keys()).sort((a, b) => a - b);

  const windows: Record<WindowKey, WindowStats> = {
    h24: windowStats(evs, now - DAY),
    d7: windowStats(evs, now - 7 * DAY),
    d30: windowStats(evs, now - 30 * DAY),
  };
  const d30 = windows.d30;

  const connects = CLIENTS.map(([client, weight, probe]) => ({ client, connects: Math.round(weight * (probe ? 55 : 6)), probe }));
  const funnel = CLIENTS.filter(([, , probe]) => !probe).map(([client, weight]) => {
    const sessions = Math.round(weight * 7);
    return { client, sessions, sessions_with_call: Math.round(sessions * 0.62), sessions_family_complete: Math.round(sessions * 0.21), sessions_paid: Math.round(sessions * 0.08) };
  });
  const revenueByClient = new Map<string, number>();
  real.forEach((e) => revenueByClient.set(e.client, (revenueByClient.get(e.client) ?? 0) + e.revenue));

  const recent_errors = real.filter((e) => e.type === "tool_error").slice(-60).reverse().map((e) => ({
    ts: e.ts, tool: e.tool, type: e.type, class: e.cls, paged: e.cls === "internal", payer: e.payer,
    client_name: e.client, client: e.client + "/1.4.2 (+https://example.test)", detail: e.detail,
  }));

  const purchases = scenario === "empty" ? [] : Array.from({ length: 23 }, (_, i) => {
    const fiat = i % 3 === 0;
    return {
      ts: now - (i * 11 + 3) * DAY + 3600000 * ((i * 7) % 24),
      type: fiat ? "fiat_deposit_success" : "deposit_success",
      payer: fiat ? "acct:" + String(i).padStart(8, "0") + "-4e1b-8c2a-9f30-2c6d1a7b5e90" : "0x" + (i * 2654435761).toString(16).padStart(40, "c"),
      amount: fiat ? [5, 10, 20][i % 3] : [0.5, 1, 2, 5][i % 4],
      detail: i === 4 ? "replay of order 7f3a… (webhook redelivered)" : fiat ? "Polar order " + (9000 + i) : "tx 0x" + (i * 977).toString(16).padStart(12, "e") + "…",
    };
  });

  const health = scenario === "problems"
    ? {
      broken_tools: [{ tool: "screenshot_url", total: 9, errors: 8, pct: 89, payers: 4, topDetail: "ScreenshotOne HTTP 402: quota exceeded" }],
      last_event_ts: now - 4 * 3600000,
      crons: [
        { name: "health", last_ok_ts: now - 5 * 60000, last_error: null, last_error_ts: null, muted: false },
        { name: "usage-alerts", last_ok_ts: now - 26 * 3600000, last_error: "D1_ERROR: too many rows read", last_error_ts: now - 2 * 3600000, muted: false },
        { name: "x-agent-metrics", last_ok_ts: now - 3 * DAY, last_error: "(402) credits-depleted", last_error_ts: now - 3600000, muted: true },
      ],
    }
    : {
      broken_tools: [],
      last_event_ts: evs.length ? evs[evs.length - 1].ts : null,
      crons: [
        { name: "health", last_ok_ts: now - 4 * 60000, last_error: null, last_error_ts: null, muted: false },
        { name: "usage-alerts", last_ok_ts: now - 9 * 3600000, last_error: null, last_error_ts: null, muted: false },
        { name: "x-agent-publisher", last_ok_ts: now - 3 * 60000, last_error: null, last_error_ts: null, muted: false },
        { name: "deploy-watch", last_ok_ts: now - 4 * 60000, last_error: null, last_error_ts: null, muted: false },
        { name: "x-agent-metrics", last_ok_ts: now - 3 * DAY, last_error: "(402) credits-depleted", last_error_ts: now - 3600000, muted: true },
      ],
    };

  return {
    summary: {
      calls_30d: d30.calls,
      revenue_30d: d30.revenue,
      unique_payers_30d: d30.unique_payers,
      unique_anon_agents_30d: d30.unique_anon_agents,
      returning_agents_7d: scenario === "empty" ? 0 : 6,
      avg_latency_ms: d30.avg_latency_ms,
      p50_latency_ms: d30.p50_latency_ms,
      p95_latency_ms: d30.p95_latency_ms,
    },
    calls_by_day,
    revenue_by_day,
    calls_by_halfhour: hhKeys.map((ts) => ({ ts, calls: hh.get(ts)!.calls })),
    revenue_by_halfhour: hhKeys.map((ts) => ({ ts, revenue: Math.round(hh.get(ts)!.revenue * 1e6) / 1e6 })),
    top_tools: d30.top_tools,
    payment_breakdown: d30.payment_breakdown,
    credits: scenario === "empty"
      ? { purchased_30d: { crypto: { count: 0, total_usdc: 0 }, fiat: { count: 0, total_usdc: 0 } }, outstanding_usdc: 0, lifetime_purchased_usdc: 0, lifetime_consumed_usdc: 0, accounts: 0 }
      : { purchased_30d: { crypto: { count: 2, total_usdc: 3 }, fiat: { count: 1, total_usdc: 10 } }, outstanding_usdc: 41.37, lifetime_purchased_usdc: 118.5, lifetime_consumed_usdc: 77.13, accounts: 14 },
    credit_purchases: purchases,
    recent_errors,
    by_window: windows,
    retention: { events_days: 365, connect_days: 60, oldest_event_ts: now - 114 * DAY, surface_days: 7 },
    health,
    error_rate_by_tool: d30.error_rate_by_tool,
    latency_by_tool: d30.latency_by_tool,
    directory_coverage: scenario === "empty" ? [] : connects.filter((c) => c.probe).map((c) => ({ client: c.client, hits: c.connects, last_seen: now - 3600000 * (1 + connects.indexOf(c)) })),
    directory_stats: scenario === "empty" ? [] : [
      { source: "glama", use_count: null, ts: now - 5 * 3600000 },
    ],
    paywall_funnel: d30.paywall_funnel,
    surface: {
      connects_by_client: connects,
      calls_by_client: d30.calls_by_client,
      revenue_by_client: Array.from(revenueByClient.entries()).map(([client, revenue]) => ({ client, revenue: Math.round(revenue * 1e6) / 1e6 })),
      funnel_by_client: funnel,
    },
  } as DashboardData;
}
