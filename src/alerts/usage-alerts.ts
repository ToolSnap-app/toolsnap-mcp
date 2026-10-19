import type { Env } from "../index.js";
import { sendTelegram } from "./telegram.js";

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
const ANALYTICS_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
// 60 dias para los eventos `connect`, que son el 83% de la tabla (33k de
// 39.6k) y solo se leen en tres sitios, todos con ventana corta: los
// "connects por cliente" del panel (30d) y las dos mitades del digest
// semanal (14d). Todo connect mas viejo que eso es peso muerto que solo
// encarece cada escaneo. 60d deja 2x de margen sobre la ventana mas larga.
const CONNECT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/** Payment types that mean the tool actually executed (hit the provider). */
const EXECUTED_TYPES = ["x402_paid", "prepaid", "free_tool", "x402_free_first"];

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

// directory_stats (2 filas/dia, migracion 0013) tambien se poda: ~400 dias.
const DIRECTORY_STATS_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * Poda de telemetria (las tablas del ledger de dinero no se tocan). Registra
 * las filas borradas por tramo; si un tramo falla avisa por Telegram (1/24 h,
 * best-effort) y NO relanza, para no tumbar el cron de alertas.
 */
export async function runRetention(env: Env, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  const tramos: Array<[string, string, number]> = [
    ["connect", `DELETE FROM analytics_events WHERE ts < ? AND payment_type = 'connect'`, nowMs - CONNECT_RETENTION_MS],
    ["events", `DELETE FROM analytics_events WHERE ts < ?`, nowMs - ANALYTICS_RETENTION_MS],
    ["directory_stats", `DELETE FROM directory_stats WHERE ts < ?`, nowMs - DIRECTORY_STATS_RETENTION_MS],
  ];
  for (const [name, sql, cutoff] of tramos) {
    try {
      const res = await env.PREPAID_DB.prepare(sql).bind(cutoff).run();
      console.log(`retention ${name}: deleted ${res.meta?.changes ?? 0} rows`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`retention ${name} failed:`, message);
      let throttled = false;
      try {
        throttled = !!(await env.X402_NONCES.get("alert:retention"));
        if (!throttled) {
          await env.X402_NONCES.put("alert:retention", "1", { expirationTtl: 24 * 60 * 60 });
        }
      } catch (kvErr) {
        console.warn("retention alert KV failed:", kvErr instanceof Error ? kvErr.message : String(kvErr));
      }
      if (!throttled) {
        await sendTelegram(env, `🔴 *retención de analytics fallando*\ntramo ${name}: ${message}`);
      }
    }
  }
}

export async function checkUsageAlerts(env: Env, now: Date = new Date()): Promise<void> {
  // Purge temporary R2 files older than 24 h.
  const TTL_24H = 24 * 60 * 60 * 1000;
  await Promise.all([
    purgeOldR2Objects(env.SCREENSHOTS_BUCKET, "rembg/", TTL_24H, now),
    purgeOldR2Objects(env.SCREENSHOTS_BUCKET, "uploads/", TTL_24H, now),
  ]);

  await runRetention(env, now);
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
