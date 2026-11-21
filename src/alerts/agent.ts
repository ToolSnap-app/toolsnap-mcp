/**
 * Alert agent, phase 1: shadow mode.
 *
 * Until now the loop was manual: an alert reaches Telegram, Unai reads it and
 * opens a Claude session to find out whether it needs anything. page() closes
 * that loop for the alerts that go through it: the Telegram message goes out
 * exactly as before, and then the same incident is handed to a Claude Code
 * cloud scheduled task (its API trigger, POST .../fire) that triages it and
 * answers with a verdict threaded under the alert (POST /alerts/agent/verdict).
 *
 * Shadow mode means the agent only gives an opinion. It holds no credential
 * that can change anything here: its only way in is the verdict endpoint, which
 * can do one thing, post a plain-text reply in the alerts chat.
 *
 * Rules this file keeps:
 *  - Telegram first. The pager never depends on the agent: a fire that fails,
 *    is throttled or is not configured changes nothing about the alert.
 *  - Off by default. Without ALERT_AGENT_FIRE_URL + ALERT_AGENT_FIRE_TOKEN
 *    nothing is fired; without ALERT_AGENT_TOKEN the verdict endpoint is 404.
 *  - Bounded. One fire per fingerprint per 6 h, 4 per hour, 12 per day. Every
 *    fire is a cloud session that spends subscription usage, and an alert
 *    storm must not become a session storm.
 *  - Everything in the payload is data. Alerts interpolate strings anyone can
 *    write (a tool's error detail, a client name), so those travel under
 *    `untrusted`, truncated, and the task's prompt treats the whole payload as
 *    untrusted (the /fire endpoint also wraps it that way).
 *  - The context the agent needs rides in the payload (recent events for the
 *    tool and the payer, one bounded query), so the agent needs no read access
 *    to production and cannot spend the D1 row budget on its own.
 */
import { sendTelegramMessage, type TelegramEnv } from "./telegram.js";

export interface AgentEnv extends TelegramEnv {
  /** API trigger of the triage task: https://api.anthropic.com/v1/claude_code/routines/<id>/fire */
  ALERT_AGENT_FIRE_URL?: string;
  /** Bearer token of that API trigger (scoped to firing that one task). Secret. */
  ALERT_AGENT_FIRE_TOKEN?: string;
  /** Bearer the agent presents on POST /alerts/agent/verdict. Secret. */
  ALERT_AGENT_TOKEN?: string;
  X402_NONCES?: KVNamespace;
  PREPAID_DB?: D1Database;
}

export interface Incident {
  /** What fired: tool_error, settle_failed, deposit_failed, fiat_deposit_failed, 402_rejected, broken_tool, cron_failed. */
  kind: string;
  /** Stable grouping key (the alert's own dedupe key). Same fingerprint inside the window = no second fire. */
  fingerprint: string;
  /** Values this Worker computed (counts, classes, names it owns). */
  facts?: Record<string, string | number | boolean | null | undefined>;
  /** Strings that come from callers or upstreams. Truncated; never instructions. */
  untrusted?: Record<string, string | null | undefined>;
  /** Tool and payer to pull recent events for (see loadIncidentContext). */
  tool?: string | null;
  payer?: string | null;
}

export type FireOutcome = "fired" | "off" | "throttled" | "failed";

const HOUR_MS = 60 * 60 * 1000;
export const FINGERPRINT_WINDOW_MS = 6 * HOUR_MS;
export const MAX_FIRES_PER_HOUR = 4;
export const MAX_FIRES_PER_DAY = 12;
const FIRE_LOG_KEY = "agent:fires";
const FIRE_LOG_TTL_SEC = 25 * 60 * 60;
const FIRE_TIMEOUT_MS = 10_000;
const FIRE_HOST_PREFIX = "https://api.anthropic.com/";
const ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

const UNTRUSTED_MAX = 300;
const ALERT_TEXT_MAX = 1500;
const PAYLOAD_MAX = 14_000;
export const CONTEXT_WINDOW_MS = 2 * HOUR_MS;
const CONTEXT_ROWS = 40;
const CONTEXT_DETAIL_MAX = 140;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// --- throttle ---------------------------------------------------------------

interface FireMark {
  fp: string;
  ts: number;
}

/** Per-isolate copy of the fire log: the floor when KV is unavailable or out of write quota. */
let memFires: FireMark[] = [];

/** Test hook. */
export function resetAgentState(): void {
  memFires = [];
  verdictTimes = [];
}

function isFireMark(x: unknown): x is FireMark {
  return typeof x === "object" && x !== null && typeof (x as FireMark).fp === "string" && typeof (x as FireMark).ts === "number";
}

async function readFireLog(kv: KVNamespace | undefined, now: number): Promise<FireMark[]> {
  let stored: FireMark[] = [];
  if (kv) {
    try {
      const raw = await kv.get(FIRE_LOG_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) stored = parsed.filter(isFireMark);
    } catch (err) {
      console.warn("alert agent: fire log KV read failed:", err instanceof Error ? err.message : String(err));
    }
  }
  // KV is the shared truth; the in-memory copy covers what this isolate fired
  // and could not write. Union of both, last 24 h.
  const seen = new Set<string>();
  return [...stored, ...memFires].filter((m) => {
    const id = `${m.fp}@${m.ts}`;
    if (now - m.ts >= 24 * HOUR_MS || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function fireAllowed(log: readonly FireMark[], fingerprint: string, now: number): boolean {
  if (log.some((m) => m.fp === fingerprint && now - m.ts < FINGERPRINT_WINDOW_MS)) return false;
  if (log.filter((m) => now - m.ts < HOUR_MS).length >= MAX_FIRES_PER_HOUR) return false;
  return log.length < MAX_FIRES_PER_DAY;
}

async function recordFire(kv: KVNamespace | undefined, log: FireMark[], mark: FireMark): Promise<void> {
  const next = [...log, mark];
  memFires = next;
  if (!kv) return;
  try {
    await kv.put(FIRE_LOG_KEY, JSON.stringify(next), { expirationTtl: FIRE_LOG_TTL_SEC });
  } catch (err) {
    // Fase 25.14 — the KV write quota is shared with the x402 nonces and can
    // run out; the in-memory copy keeps this isolate honest meanwhile.
    console.warn("alert agent: fire log KV write failed:", err instanceof Error ? err.message : String(err));
  }
}

// --- context ----------------------------------------------------------------

export interface ContextRow {
  ts: number;
  tool_name: string;
  payment_type: string;
  detail: string | null;
  client_name: string | null;
  client: string | null;
  payer: string;
}

/**
 * Recent events for the incident's tool and payer, newest first. ONE query over
 * the same 2 h window the health check already reads every 5 minutes, so a fire
 * costs at most one more pass over it (and fires are capped at 4 per hour).
 * Best-effort: any failure (D1 out of quota included) yields null and the
 * agent triages with what the alert itself says.
 */
export async function loadIncidentContext(
  db: D1Database | undefined,
  incident: Pick<Incident, "tool" | "payer">,
  now: number
): Promise<ContextRow[] | null> {
  const tool = incident.tool || null;
  // "anon" is every anonymous caller at once, not one agent.
  const payer = incident.payer && incident.payer !== "anon" ? incident.payer : null;
  if (!db || (!tool && !payer)) return null;
  try {
    const res = await db
      .prepare(
        `SELECT ts, tool_name, payment_type, detail, client_name, client, payer
           FROM analytics_events
          WHERE ts >= ? AND (tool_name = ? OR payer = ?)
            AND payment_type <> 'connect' AND internal = 0
          ORDER BY ts DESC
          LIMIT ${CONTEXT_ROWS}`
      )
      .bind(now - CONTEXT_WINDOW_MS, tool ?? "", payer ?? "")
      .all<ContextRow>();
    return (res.results ?? []).map((r) => ({ ...r, detail: r.detail ? clip(r.detail, CONTEXT_DETAIL_MAX) : r.detail }));
  } catch (err) {
    console.warn("alert agent: context query failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// --- fire -------------------------------------------------------------------

export interface FirePayload {
  v: 1;
  mode: "shadow";
  kind: string;
  fingerprint: string;
  fired_at: string;
  /** Telegram message id of the alert; echo it back as `reply_to` in the verdict. */
  reply_to: number | null;
  facts: Record<string, string | number | boolean | null>;
  untrusted: Record<string, string>;
  alert_text: string;
  context_window_minutes: number;
  context: ContextRow[] | null;
}

export function buildFirePayload(
  incident: Incident,
  alertText: string,
  replyTo: number | null,
  context: ContextRow[] | null,
  now: number
): string {
  const facts: FirePayload["facts"] = {};
  for (const [k, v] of Object.entries(incident.facts ?? {})) {
    if (v === undefined) continue;
    facts[k] = typeof v === "string" ? clip(v, UNTRUSTED_MAX) : v;
  }
  const untrusted: FirePayload["untrusted"] = {};
  for (const [k, v] of Object.entries(incident.untrusted ?? {})) {
    if (v) untrusted[k] = clip(v, UNTRUSTED_MAX);
  }
  const payload: FirePayload = {
    v: 1,
    mode: "shadow",
    kind: clip(incident.kind, 60),
    fingerprint: clip(incident.fingerprint, 200),
    fired_at: new Date(now).toISOString(),
    reply_to: replyTo,
    facts,
    untrusted,
    alert_text: clip(alertText, ALERT_TEXT_MAX),
    context_window_minutes: CONTEXT_WINDOW_MS / 60_000,
    context,
  };
  // The fire text is freeform and unparsed on the other side; keep it small.
  // Oldest context rows go first, then the context altogether.
  let text = JSON.stringify(payload);
  while (text.length > PAYLOAD_MAX && payload.context && payload.context.length > 0) {
    payload.context = payload.context.slice(0, Math.floor(payload.context.length / 2));
    text = JSON.stringify(payload);
  }
  return text;
}

/**
 * Hand one incident to the triage task. Never throws. Call it only after the
 * Telegram alert is out (page() does).
 */
export async function fireAgent(
  env: AgentEnv,
  incident: Incident,
  alertText: string,
  replyTo: number | null,
  now: number = Date.now()
): Promise<FireOutcome> {
  try {
    const url = env.ALERT_AGENT_FIRE_URL;
    const token = env.ALERT_AGENT_FIRE_TOKEN;
    if (!url || !token) return "off";
    // The payload carries payer ids and error details: it goes to the task's
    // own endpoint or nowhere, whatever the variable ends up holding.
    if (!url.startsWith(FIRE_HOST_PREFIX)) {
      console.warn("alert agent: ALERT_AGENT_FIRE_URL is not an api.anthropic.com URL; not firing");
      return "off";
    }

    const log = await readFireLog(env.X402_NONCES, now);
    if (!fireAllowed(log, incident.fingerprint, now)) {
      console.log(`alert agent: throttled ${incident.fingerprint}`);
      return "throttled";
    }
    // Marked before the request: a fire that times out may still have started
    // a session, and a retry storm is worse than one missed triage.
    await recordFire(env.X402_NONCES, log, { fp: incident.fingerprint, ts: now });

    const context = await loadIncidentContext(env.PREPAID_DB, incident, now);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": ROUTINE_BETA,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: buildFirePayload(incident, alertText, replyTo, context, now) }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`alert agent: fire answered HTTP ${res.status} for ${incident.fingerprint}`);
      return "failed";
    }
    console.log(`alert agent: fired ${incident.fingerprint}`);
    return "fired";
  } catch (err) {
    console.warn("alert agent: fire failed:", err instanceof Error ? err.message : String(err));
    return "failed";
  }
}

/**
 * sendTelegram() for alerts the agent should also look at. Returns what
 * sendTelegram() would: whether the alert reached Telegram. The agent is only
 * told about alerts that did, so every verdict has an alert above it.
 */
export async function page(env: AgentEnv, text: string, incident: Incident): Promise<boolean> {
  const sent = await sendTelegramMessage(env, text);
  if (sent.ok) await fireAgent(env, incident, text, sent.messageId);
  return sent.ok;
}

// --- verdict ----------------------------------------------------------------

const VERDICTS = { ruido: "RUIDO", real: "FALLO REAL", humano: "DECISIÓN TUYA", dudoso: "DUDOSO" } as const;
type Verdict = keyof typeof VERDICTS;
const CONFIDENCES = new Set(["alta", "media", "baja"]);
const VERDICT_BODY_MAX = 8_000;
const VERDICT_FIELD_MAX = 700;
const MAX_VERDICTS_PER_HOUR = 20;
const SESSION_URL = /^https:\/\/claude\.ai\/code\/[\w-]{1,80}$/;

/** Per-isolate cap: a looping run or a leaked token must not turn the pager into a firehose. */
let verdictTimes: number[] = [];

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Length-independent comparison, so the answer time says nothing about the token. */
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0;
}

/**
 * The verdict is written by a model that has just read attacker-writable text,
 * and it lands in the owner's pager. It goes out as plain text (no entities to
 * forge) and with link schemes broken, so nothing in it is one tap away.
 */
function inert(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), VERDICT_FIELD_MAX).replace(/\b(https?|tg|ftp):\/\//gi, "$1[:]//");
}

export interface VerdictInput {
  reply_to: number | null;
  verdict: Verdict;
  confidence: string | null;
  summary: string;
  proposed_action: string | null;
  session_url: string | null;
}

/** Returns the parsed verdict or the reason it is not one. */
export function parseVerdict(body: unknown): VerdictInput | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.verdict !== "string" || !(b.verdict in VERDICTS)) {
    return `verdict must be one of: ${Object.keys(VERDICTS).join(", ")}`;
  }
  if (typeof b.summary !== "string" || !b.summary.trim()) return "summary is required";
  const replyTo = b.reply_to ?? null;
  if (replyTo !== null && !(typeof replyTo === "number" && Number.isInteger(replyTo) && replyTo > 0)) {
    return "reply_to must be the positive integer from the payload, or null";
  }
  const confidence = typeof b.confidence === "string" && CONFIDENCES.has(b.confidence) ? b.confidence : null;
  const proposed = typeof b.proposed_action === "string" && b.proposed_action.trim() ? b.proposed_action : null;
  const sessionUrl = typeof b.session_url === "string" && SESSION_URL.test(b.session_url) ? b.session_url : null;
  return {
    reply_to: replyTo,
    verdict: b.verdict as Verdict,
    confidence,
    summary: b.summary,
    proposed_action: proposed,
    session_url: sessionUrl,
  };
}

export function formatVerdict(v: VerdictInput): string {
  return [
    `🤖 Triaje en sombra: ${VERDICTS[v.verdict]}${v.confidence ? ` (confianza ${v.confidence})` : ""}`,
    inert(v.summary),
    v.proposed_action ? `Haría: ${inert(v.proposed_action)}` : null,
    v.session_url,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** POST /alerts/agent/verdict — the agent's only way back in. */
export async function handleAgentVerdict(request: Request, env: AgentEnv, now: number = Date.now()): Promise<Response> {
  // Not configured = the feature does not exist here.
  if (!env.ALERT_AGENT_TOKEN) return json({ error: "Not found" }, 404);
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim() ?? "";
  if (!sameSecret(bearer, env.ALERT_AGENT_TOKEN)) return json({ error: "Invalid or missing token." }, 401);

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Unreadable body." }, 400);
  }
  if (raw.length > VERDICT_BODY_MAX) return json({ error: "Body too large." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const verdict = parseVerdict(body);
  if (typeof verdict === "string") return json({ error: verdict }, 400);

  verdictTimes = verdictTimes.filter((t) => now - t < HOUR_MS);
  if (verdictTimes.length >= MAX_VERDICTS_PER_HOUR) return json({ error: "Too many verdicts this hour." }, 429);
  verdictTimes.push(now);

  const sent = await sendTelegramMessage(env, formatVerdict(verdict), { plain: true, replyTo: verdict.reply_to });
  if (!sent.ok) return json({ error: "Telegram did not accept the verdict." }, 502);
  return json({ ok: true }, 200);
}
