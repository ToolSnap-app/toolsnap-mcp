/**
 * Fase 25.15 — la retencion de analytics_events, declarada una vez.
 *
 * La aplica el cron diario (src/alerts/usage-alerts.ts) y la ENSENA el panel
 * (summary.retention): con 90d o 1y seleccionados, las tarjetas de superficie
 * y agentes solo pueden cubrir 60 dias de connects, y antes nadie lo decia.
 * La web (privacy/security) prometia 730 dias; se corrige a lo real aqui.
 */
export const ANALYTICS_RETENTION_DAYS = 365;
export const CONNECT_RETENTION_DAYS = 60;
