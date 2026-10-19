import type { Env } from "../index.js";
import { sendTelegram } from "./telegram.js";
import { EXECUTED_TYPES } from "../analytics/payment-types.js";
import { ANALYTICS_RETENTION_DAYS, CONNECT_RETENTION_DAYS } from "../analytics/retention.js";

/**
 * Usage alerts for COGS tools backed by an external provider with a free-tier
 * quota (screenshot_url → ScreenshotOne, 100/month free, break-even ~135/month).
 *
 * Run daily by a Cron Trigger. It:
 *  - counts this month's executed screenshot_url calls,
 *  - fires a Telegram alert when usage crosses 50 / 90 / 100 (each once per
 *    month, de-duped via KV), so we get an early heads-up and a near-limit
 *    warning in time to decide on Workers Paid / overage,
 *  - on Mondays, sends a weekly usage digest.
 *
 * Safe before configuration: sendTelegram no-ops without bot token + chat id.
 */

const FREE_TIER = 100; // ScreenshotOne free screenshots / month
const BREAK_EVEN = 135; // monthly paid calls that cover Workers Paid $5/mo
const THRESHOLDS = [50, 90, 100];
const KV_TTL_SEC = 45 * 24 * 60 * 60;
// Retencion de analytics_events. Fase 25.8 — la restriccion que manda no es
// el espacio (D1 free = 5 GB) sino las FILAS LEIDAS: 5M/dia a partir del
// 2026-09-01. Cada fila que sobrevive la escanean las consultas del panel,
// asi que la tabla se mantiene pequena a proposito.
//
// 1 ano para los eventos reales — cubre el timeframe de 1y del panel y a
// ~150 llamadas/dia son ~55k filas, perfectamente escaneables.
const ANALYTICS_RETENTION_MS = ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
// 60 dias para los eventos `connect`, que son el 83% de la tabla (33k de
// 39.6k) y solo se leen en tres sitios, todos con ventana corta: los
// "connects por cliente" del panel (30d) y las dos mitades del digest
// semanal (14d). Todo connect mas viejo que eso es peso muerto que solo
// encarece cada escaneo. 60d deja 2x de margen sobre la ventana mas larga.
const CONNECT_RETENTION_MS = CONNECT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Fase 25.15 — EXECUTED_TYPES viene de analytics/payment-types.ts: la lista
// local omitia api_key y oauth, asi que una captura pagada por esos rails no
// contaba para el aviso de cuota de ScreenshotOne.

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfMonthMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Count this month's executed screenshot_url calls. */
async function monthScreenshotCount(env: Env, now: Date): Promise<number> {
  const placeholders = EXECUTED_TYPES.map(() => "?").join(",");
  const row = await env.PREPAID_DB.prepare(
    `SELECT count(*) AS n FROM analytics_events
     WHERE tool_name = 'screenshot_url'
       AND ts >= ?
       AND payment_type IN (${placeholders})`
  )
    .bind(startOfMonthMs(now), ...EXECUTED_TYPES)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Delete R2 objects under the given prefix that are older than maxAgeMs. */
async function purgeOldR2Objects(
  bucket: R2Bucket,
  prefix: string,
  maxAgeMs: number,
  now: Date
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (now.getTime() - obj.uploaded.getTime() > maxAgeMs) {
        await bucket.delete(obj.key);
        deleted++;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}

export async function checkUsageAlerts(env: Env, now: Date = new Date()): Promise<void> {
  // Purge temporary R2 files older than 24 h.
  const TTL_24H = 24 * 60 * 60 * 1000;
  await Promise.all([
    purgeOldR2Objects(env.SCREENSHOTS_BUCKET, "rembg/", TTL_24H, now),
    purgeOldR2Objects(env.SCREENSHOTS_BUCKET, "uploads/", TTL_24H, now),
  ]);

  // Retencion en dos tramos (las tablas del ledger de dinero no se tocan —
  // esto solo poda el log de telemetria append-only).
  await env.PREPAID_DB.batch([
    env.PREPAID_DB.prepare(
      `DELETE FROM analytics_events WHERE ts < ? AND payment_type = 'connect'`
    ).bind(now.getTime() - CONNECT_RETENTION_MS),
    env.PREPAID_DB.prepare(`DELETE FROM analytics_events WHERE ts < ?`).bind(
      now.getTime() - ANALYTICS_RETENTION_MS
    ),
  ]).catch(() => {
    // Retention is best-effort — never let it break the alerts cron.
  });
  const count = await monthScreenshotCount(env, now);
  const month = monthKey(now);

  // Threshold crossings — each fires once per month.
  for (const t of THRESHOLDS) {
    if (count < t) continue;
    const flagKey = `alert:screenshot:${month}:${t}`;
    const already = await env.X402_NONCES.get(flagKey);
    if (already) continue;
    await env.X402_NONCES.put(flagKey, new Date().toISOString(), {
      expirationTtl: KV_TTL_SEC,
    }).catch((err: unknown) => {
      // Fase 25.14 — best-effort: worst case the threshold alert repeats next run.
      console.warn("screenshot threshold KV write failed:", err instanceof Error ? err.message : String(err));
    });
    let msg: string;
    if (t >= FREE_TIER) {
      msg = `🔴 *ToolSnap* — screenshot_url ha llegado a *${count}* este mes (${month}).\nFree tier de ScreenshotOne (${FREE_TIER}/mes) AGOTADO → ahora pagas overage (~$0.009/captura). Break-even Workers Paid: ${BREAK_EVEN}/mes. Considera activar self-host (camino A).`;
    } else if (t >= 90) {
      msg = `🟠 *ToolSnap* — screenshot_url va por *${count}* este mes (${month}).\nCerca del free tier (${FREE_TIER}/mes). Decide pronto: seguir con overage o activar Workers Paid + self-host.`;
    } else {
      msg = `🟢 *ToolSnap* — screenshot_url va por *${count}* este mes (${month}).\nAviso temprano (umbral ${t}). Queda margen hasta el free tier (${FREE_TIER}/mes).`;
    }
    await sendTelegram(env, msg);
  }

  // Weekly digest on Mondays.
  if (now.getUTCDay() === 1) {
    const digestKey = `digest:screenshot:${month}:w${weekOfMonth(now)}`;
    const sent = await env.X402_NONCES.get(digestKey);
    if (!sent) {
      await env.X402_NONCES.put(digestKey, "1", { expirationTtl: KV_TTL_SEC }).catch((err: unknown) => {
        console.warn("screenshot digest KV write failed:", err instanceof Error ? err.message : String(err));
      });
      const remaining = Math.max(0, FREE_TIER - count);
      await sendTelegram(
        env,
        `📊 *ToolSnap — resumen semanal* (${month})\nscreenshot_url este mes: *${count}*\nQuedan ~*${remaining}* del free tier (${FREE_TIER}/mes).\nBreak-even Workers Paid: ${BREAK_EVEN}/mes.`
      );
    }
  }
}

function weekOfMonth(d: Date): number {
  return Math.ceil(d.getUTCDate() / 7);
}
