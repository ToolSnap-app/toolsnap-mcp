/**
 * Fase B2 (Analytics v2) — resumen diario `analytics_daily` (migrations/0019).
 *
 * Las series calls_by_day / revenue_by_day del panel leian TODOS los eventos
 * no-connect de 365 d (14,7 k filas, creciendo ~130/dia). Ahora salen de una
 * fila por (dia UTC, internal, probe), que rellena el cron diario. Mismas
 * definiciones que rollupSeries: calls cuenta todas las filas no-connect
 * (depositos incluidos), revenue solo las que no son deposito.
 */
import { IS_PROBE_SQL } from "./queries.js";
import { DEPOSIT_TYPES_SQL } from "./payment-types.js";

const DAY_MS = 86_400_000;

/**
 * INSERT OR REPLACE ... SELECT GROUP BY de los ultimos `days` dias UTC (hoy
 * incluido, completo desde las 00:00 UTC). days=2 es el del cron (hoy y ayer);
 * days=365 es el backfill inicial.
 */
export function dailyRollupSql(): string {
  return `INSERT OR REPLACE INTO analytics_daily (day, internal, probe, calls, revenue_usdc)
    SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
           internal,
           COALESCE(${IS_PROBE_SQL}, 0) AS probe,
           count(*) AS calls,
           COALESCE(sum(CASE WHEN payment_type NOT IN (${DEPOSIT_TYPES_SQL}) THEN revenue_usdc ELSE 0 END), 0) AS revenue_usdc
    FROM analytics_events
    WHERE ts >= ? AND payment_type != 'connect'
    GROUP BY day, internal, COALESCE(${IS_PROBE_SQL}, 0)`;
}

/** Inicio (ms) del dia UTC que queda `days - 1` dias antes del de `now`. */
export function dailyRollupSince(now: number, days: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
}

/** Recalcula los ultimos `days` dias (2 por defecto). Devuelve las filas escritas. */
export async function rollupAnalyticsDaily(
  env: { PREPAID_DB: D1Database },
  now = Date.now(),
  days = 2
): Promise<number> {
  const res = await env.PREPAID_DB.prepare(dailyRollupSql()).bind(dailyRollupSince(now, days)).run();
  return res.meta?.changes ?? 0;
}
