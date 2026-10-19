/**
 * Fase 25.15 — LA definicion de "pagado" y "ejecutado", una sola vez.
 *
 * Hasta ahora vivia en cuatro sitios con tres redacciones distintas:
 * queries.ts tenia PAID_CONVERSION_TYPES (con oauth) para el embudo del panel
 * y un PAID_TYPES local SIN oauth para el digest semanal; error-alerts.ts
 * tenia el suyo (con oauth) para el 🟢 de primera llamada pagada; y
 * usage-alerts.ts contaba la cuota de ScreenshotOne con EXECUTED_TYPES, que
 * no incluia api_key ni oauth — una captura pagada con API key no contaba
 * para el aviso de cuota. Panel y digest daban dos cifras distintas para la
 * misma pregunta.
 *
 * Todo consumidor importa de aqui. Si aparece un rail nuevo, se anade en UNA
 * linea y lo ven los cuatro.
 */

/** Un tool call cobrado por cualquier rail (x402 directo, primera gratis de x402, prepago, API key, OAuth). */
export const PAID_TYPES = ["x402_paid", "x402_free_first", "prepaid", "api_key", "oauth"] as const;
export type PaidType = (typeof PAID_TYPES)[number];
export const PAID_TYPES_SET: ReadonlySet<string> = new Set(PAID_TYPES);
/** Fragmento SQL `'a', 'b', ...` — constante, nunca entrada de usuario. */
export const PAID_TYPES_SQL = PAID_TYPES.map((t) => `'${t}'`).join(", ");

/** La tool llego a ejecutarse (toco al proveedor): pagada o gratuita. */
export const EXECUTED_TYPES = [...PAID_TYPES, "free_tool"] as const;

/** Dinero entrando al sistema (compra de creditos), no ingreso por uso. */
export const DEPOSIT_TYPES = ["deposit_success", "fiat_deposit_success"] as const;
export const DEPOSIT_TYPES_SQL = DEPOSIT_TYPES.map((t) => `'${t}'`).join(", ");
