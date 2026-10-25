import { sendTelegram, type TelegramEnv } from "./telegram.js";
import { isPagedToolError } from "./error-classification.js";
import { PAID_TYPES_SET } from "../analytics/payment-types.js";

/**
 * Real-time Telegram alerts for failed/rejected analytics events, called from
 * writeEvent() right after the event is persisted. Fire-and-forget: wrapped
 * in try/catch + ctx.waitUntil so an alert failure never affects the tool
 * call that originated it. Safe before configuration — sendTelegram no-ops
 * without bot token + chat id.
 *
 * Throttled per (type, tool) via KV so a burst of the same failure sends one
 * message, not one per call.
 */

interface AlertEnv extends TelegramEnv {
  X402_NONCES?: KVNamespace;
}

interface ErrorEventParams {
  toolName: string;
  paymentType: string;
  payer: string;
  client?: string | null;
  /** Normalized MCP surface (see src/analytics/surface.ts) — used to spot directory probes. */
  clientName?: string | null;
  detail?: string | null;
}

const HOUR_SEC = 60 * 60;
const MONEY_TYPES = new Set(["settle_failed", "deposit_failed", "fiat_deposit_failed"]);

/** Provider tools prefix their thrown errors with the provider name (see src/tools/*). */
const PROVIDER_PREFIXES = ["fal.ai", "ScreenshotOne", "Microlink", "DataForSEO"];

function classifyProvider(detail?: string | null): string | null {
  if (!detail) return null;
  return PROVIDER_PREFIXES.find((p) => detail.startsWith(p)) ?? null;
}

function truncatePayer(payer: string): string {
  if (payer.startsWith("0x") && payer.length > 12) {
    return `${payer.slice(0, 6)}…${payer.slice(-4)}`;
  }
  return payer;
}

/** Returns true (and marks the key) only the first time it's called within the TTL window. */
async function shouldAlert(kv: KVNamespace | undefined, key: string, ttlSec: number): Promise<boolean> {
  if (!kv) return true; // no dedupe store available — alert anyway (best effort)
  try {
    const existing = await kv.get(key);
    if (existing) return false;
    await kv.put(key, "1", { expirationTtl: ttlSec });
  } catch (err) {
    // Fase 25.14 — a KV failure (daily write quota, transient error) must not
    // throw out of a waitUntil; behave like the no-KV branch: alert anyway.
    console.warn("alert throttle KV failed:", err instanceof Error ? err.message : String(err));
  }
  return true;
}

export function maybeAlertError(env: AlertEnv, ctx: ExecutionContext, params: ErrorEventParams): void {
  ctx.waitUntil(
    (async () => {
      try {
        const { toolName, paymentType, payer, client, clientName, detail } = params;

        // User-side rejections already surfaced to the caller and visible in
        // the panel — not a red alert. oauth_insufficient/oauth_rejected
        // (Fase 24.7) are the OAuth-rail equivalent of prepaid/api_key
        // insufficient/rejected, same reasoning. Insufficient-balance events
        // still get a 🟠 business-signal alert — see maybeAlertBusinessSignal.
        if (
          paymentType === "prepaid_rejected" ||
          paymentType === "prepaid_insufficient" ||
          paymentType === "api_key_rejected" ||
          paymentType === "api_key_insufficient" ||
          paymentType === "oauth_rejected" ||
          paymentType === "oauth_insufficient"
        ) {
          return;
        }

        // Normal x402 discovery handshake (agent probing without a wallet yet), not an error.
        if (paymentType === "402_rejected" && detail === "no_payment_payload") return;

        // Our own admin-key testing/diagnostics, not a customer-facing failure.
        if (paymentType === "tool_error" && payer === "admin") return;

        // Fase 25.9 — LA regla. Un `tool_error` solo pagina si no es ni ruido
        // del llamante ni del destino (ver error-classification.ts). Antes se
        // paginaba por defecto y se iban anadiendo excepciones; la revision del
        // 2026-09-17 conto 14 alertas en 5 dias y CERO accionables.
        //
        // Fase 25.15 — la regla vive en isPagedToolError(), que es la MISMA
        // funcion con la que el panel decide que pinta en rojo
        // (error_rate_by_tool.our_errors). Durante un mes el panel clasifico
        // tambien los 402 sin wallet y pinto 59 "fallos nuestros" mientras
        // aqui sonaban 0: dos consumidores, un solo predicado, siempre.
        if (paymentType === "tool_error" && !isPagedToolError({ paymentType, payer, detail, clientName, client })) {
          return;
        }

        let icon = "🟠";
        let key: string;
        let ttlSec: number;
        if (MONEY_TYPES.has(paymentType)) {
          icon = "🔴";
          key = `alert:err:${paymentType}`;
          ttlSec = 5 * 60;
        } else if (paymentType === "tool_error") {
          // Fase 25.9 — lo que sobrevive al filtro de arriba es un fallo real
          // de ToolSnap, no un aviso: mismo rojo que los fallos de dinero.
          icon = "🔴";
          key = `alert:err:tool_error:${toolName}`;
          ttlSec = HOUR_SEC;
        } else {
          // 402_rejected with a real payment-verification failure (not a bare handshake).
          key = `alert:err:402v:${toolName}`;
          ttlSec = HOUR_SEC;
        }

        if (!(await shouldAlert(env.X402_NONCES, key, ttlSec))) return;

        const provider = classifyProvider(detail);
        const lines = [
          `${icon} *${paymentType}* · \`${toolName}\``,
          provider ? `proveedor: ${provider}` : null,
          detail ? `detail: ${detail}` : null,
          `payer: ${truncatePayer(payer)}${client ? ` · client: ${client}` : ""}`,
        ].filter((l): l is string => l !== null);

        await sendTelegram(env, lines.join("\n"));
      } catch {
        // Alerts must never break the caller.
      }
    })()
  );
}

/*
 * Fase 24.5 tenia aqui `maybeAlertPaywallHit`: un 🟡 por cada agente que
 * chocaba con el muro de pago sin wallet. Retirado en Fase 25.9.
 *
 * Por que: el throttle era por IP y 6h, y los escaneres llegan desde una IP
 * distinta cada vez — en los 5 dias del 2026-09-17, 13 de los 17 impactos
 * fueron `agentstatus-probe` tanteando `keyword_research` desde 13 IPs, o sea
 * 13 mensajes por algo que no se puede accionar en el momento y que nunca iba
 * a convertir. Ademas era redundante: el embudo completo (agentes que vieron
 * el 402 → agentes que pagaron) ya sale cada lunes en el digest semanal
 * (surface-digest.ts, "Muro de pago → conversión") y el desglose vive en el
 * panel. Una oportunidad de conversion es material de informe, no de pager.
 */

interface BusinessSignalParams {
  toolName: string;
  paymentType: string;
  payer: string;
  revenueUsdc: number;
  client?: string | null;
  detail?: string | null;
}

const NO_BALANCE_TYPES = new Set(["prepaid_insufficient", "api_key_insufficient", "oauth_insufficient"]);
const FIRST_PAID_TTL_SEC = 7 * 24 * HOUR_SEC;
const NO_BALANCE_ALERT_TTL_SEC = 6 * HOUR_SEC;
const BAZAAR_REJECT_TTL_SEC = 24 * HOUR_SEC;

/**
 * Fase 24.7 — positive/actionable business signals that maybeAlertError
 * never surfaces (it only fires for failures): money coming in, a payer
 * converting for the first time, and a payer running dry mid-session. Called
 * from writeEvent() alongside maybeAlertError, for every event (not gated by
 * the error-type set) since these payment_types aren't failures.
 */
export function maybeAlertBusinessSignal(env: AlertEnv, ctx: ExecutionContext, params: BusinessSignalParams): void {
  ctx.waitUntil(
    (async () => {
      try {
        const { toolName, paymentType, payer, revenueUsdc, client, detail } = params;

        // 💰 Credit purchase (either rail). Replayed Polar webhook deliveries
        // (see index.ts /webhooks/polar) log revenue 0 with detail starting
        // "replay" — already credited once, not a new sale.
        if (
          (paymentType === "deposit_success" || paymentType === "fiat_deposit_success") &&
          revenueUsdc > 0 &&
          !(detail ?? "").startsWith("replay")
        ) {
          const rail = paymentType === "fiat_deposit_success" ? "fiat" : "crypto";
          await sendTelegram(
            env,
            [
              `💰 compra de créditos (${rail})`,
              `importe: $${revenueUsdc.toFixed(4)}`,
              `payer: ${truncatePayer(payer)}`,
            ].join("\n")
          );
          return;
        }

        // 🟠 CDP settled the payment but its Bazaar crawler refused the listing
        // (settler=cdp bazaar=rejected (reason)): the tool will not enter the
        // catalog until fixed. Once per tool per day; processing/success are
        // the normal answers and stay silent.
        if (paymentType === "x402_paid" && /\bbazaar=rejected\b/.test(detail ?? "")) {
          if (await shouldAlert(env.X402_NONCES, `alert:bazaarreject:${toolName}`, BAZAAR_REJECT_TTL_SEC)) {
            await sendTelegram(
              env,
              [`🟠 Bazaar rechazó el listado de \`${toolName}\``, `detail: ${detail}`].join("\n")
            );
          }
        }

        // 🟢 First paid call from this payer — the conversion the 🟡 paywall
        // alert (maybeAlertPaywallHit) is watching for. At most once/week per
        // payer so a payer's Nth call that week doesn't re-alert.
        if (PAID_TYPES_SET.has(paymentType) && payer && payer !== "anon") {
          if (!(await shouldAlert(env.X402_NONCES, `alert:firstpaid:${payer}`, FIRST_PAID_TTL_SEC))) return;
          await sendTelegram(
            env,
            [
              `🟢 primera llamada pagada de este agente`,
              `tool: \`${toolName}\` · rail: ${paymentType}`,
              `payer: ${truncatePayer(payer)}${client ? ` · client: ${client}` : ""}`,
              ...(detail ? [`detail: ${detail}`] : []),
            ].join("\n")
          );
          return;
        }

        // 🟠 Identified payer ran out of balance mid-session — churn risk or
        // a recharge opportunity, not a ToolSnap malfunction (maybeAlertError
        // deliberately skips these, see the early-return above).
        if (NO_BALANCE_TYPES.has(paymentType)) {
          if (!(await shouldAlert(env.X402_NONCES, `alert:nobalance:${payer}`, NO_BALANCE_ALERT_TTL_SEC))) return;
          await sendTelegram(
            env,
            [
              `🟠 cliente sin saldo`,
              `tool: \`${toolName}\` · rail: ${paymentType}`,
              `payer: ${truncatePayer(payer)}${client ? ` · client: ${client}` : ""}`,
            ].join("\n")
          );
        }
      } catch {
        // Alerts must never break the caller.
      }
    })()
  );
}
