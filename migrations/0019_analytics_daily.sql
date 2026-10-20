-- Fase B2 (Analytics v2): resumen diario para las series del panel.
-- Una fila por (dia UTC, internal, probe). calls = todas las filas no-connect
-- (los depositos cuentan como llamada); revenue_usdc = suma de las que no son
-- deposito. Lo rellena el cron diario (src/analytics/daily.ts). No se poda:
-- 365 filas x <=4 combinaciones al ano.
CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  internal INTEGER NOT NULL,
  probe INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  revenue_usdc REAL NOT NULL,
  PRIMARY KEY (day, internal, probe)
);
