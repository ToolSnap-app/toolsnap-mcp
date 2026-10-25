/**
 * Pager for "payment settled, nonce not recorded in KV".
 *
 * settlePayment() writes the used nonce to X402_NONCES after the on-chain
 * transfer. If that write fails (free-tier quota of 1,000 puts/day, or an
 * outage) the payment still went through and the caller still gets credited;
 * only the KV replay pre-check is missing for that nonce, and the chain's
 * authorizationState keeps covering it. That is worth ONE page, not one per
 * payment: while the quota is exhausted every settlement would trip this, so
 * the alert is throttled per isolate. The throttle lives in memory on purpose,
 * because the usual KV-backed throttle is exactly what is broken here.
 */
import { sendTelegram, type TelegramEnv } from "../alerts/telegram.js";

const ALERT_MIN_INTERVAL_MS = 60 * 60 * 1000;
let lastAlertAt = 0;

export interface NonceAlertInfo {
  kind: "deposit" | "pay_per_call";
  payer: string;
  txHash: string;
  nonce: string;
}

/** Test hook: forget the last alert time so the next call pages again. */
export function resetNonceAlertThrottle(): void {
  lastAlertAt = 0;
}

/**
 * Page once per hour per isolate. Never throws and never blocks the response:
 * the send is handed to ctx.waitUntil.
 */
export function alertNonceNotRecorded(
  env: TelegramEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  info: NonceAlertInfo,
  now: number = Date.now()
): boolean {
  if (now - lastAlertAt < ALERT_MIN_INTERVAL_MS) return false;
  lastAlertAt = now;
  const text = [
    "⚠️ *x402: pago liquidado sin nonce en KV*",
    `tipo: ${info.kind}`,
    `payer: \`${info.payer}\``,
    `tx: \`${info.txHash}\``,
    "La escritura en X402\\_NONCES ha fallado (¿cuota KV agotada?). El cobro y el abono son correctos; solo falta el pre-check de replay en KV. Avisos limitados a uno por hora.",
  ].join("\n");
  ctx.waitUntil(
    sendTelegram(env, text).catch((err) => {
      console.warn("nonce alert failed:", err instanceof Error ? err.message : String(err));
      return false;
    })
  );
  return true;
}
