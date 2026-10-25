import type { Env } from "../index.js";
import { isD1Unavailable } from "../d1-errors.js";
import { sendTelegram } from "./telegram.js";
import { classifyToolError } from "./error-classification.js";
import { isProbeClient } from "../analytics/surface.js";
import { safeFetch } from "../tools/safe-fetch.js";

/**
 * Fase 25.9 — vigilancia AGREGADA del servidor. El pager por evento
 * (error-alerts.ts) solo sabe mirar una llamada aislada, y por eso se le
 * escapan justo los dos fallos que de verdad requieren atencion:
 *
 *  1. Una tool que ha dejado de funcionar para TODO el mundo. Vista llamada a
 *     llamada cada error parece ruido del llamante o del destino; vista como
 *     tasa, "el 90% de las llamadas reales a fetch_extract fallan" es
 *     inequivoco. Es tambien la senal que pide "ajusta el MCP": si el 100% de
 *     los agentes llama mal a una tool, el problema es nuestro esquema o
 *     nuestra descripcion, no ellos.
 *
 *     Fase 25.10 anade lo que faltaba para que "todo el mundo" signifique algo:
 *     un minimo de agentes distintos (BREAKAGE_MIN_PAYERS). Una tasa alta
 *     construida por un solo payer no es una tool rota, es una sesion.
 *
 *  2. Silencio. Nada falla porque no llega nada. Un Worker caido, una ruta
 *     rota o el rail de OAuth fuera de servicio no generan ni un evento de
 *     error — generan un vacio, y un vacio no dispara ningun pager por evento.
 *     Es exactamente la forma del incidente del CMS que estuvo 9 dias roto sin
 *     que nadie se enterara.
 *
 * Corre sobre el Cron Trigger de 5 minutos que ya existe (el publisher de X),
 * sin anadir un tercer trigger. Coste en D1: dos consultas que resuelven por
 * indice (idx_ae_noconnect_ts / idx_ae_ts), del orden de decenas de filas
 * leidas por pasada — irrelevante frente al presupuesto de 5M/dia que vigila
 * Fase 25.8.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Ventana y umbrales de "esta tool esta rota". */
const BREAKAGE_WINDOW_MS = 6 * HOUR_MS;
/** Por debajo de esto no hay muestra suficiente para hablar de una tasa. */
const BREAKAGE_MIN_CALLS = 5;
const BREAKAGE_PCT = 80;
const BREAKAGE_DEDUPE_SEC = 12 * 60 * 60;
/**
 * Fase 25.10 — "para TODO el mundo" hay que medirlo, no suponerlo.
 *
 * El 2026-09-18 esta alerta sonó por `fetch_metadata`: 12/15 llamadas reales
 * fallidas en 6h, todas `Fetch failed: HTTP 404 Not Found`... y las 15 del
 * MISMO payer (`anon:1bde233d85ac`, python-httpx). No era la tool rota: era un
 * agente recorriendo URLs que no existen. La tool respondia perfectamente al
 * resto — de hecho 4 de esas 15 llamadas suyas fueron un exito.
 *
 * Con un solo agente en la ventana no hay nada que distinga "la tool esta
 * rota" de "este agente esta pidiendo cosas que no existen", asi que un unico
 * payer no paga el precio de despertar a nadie: queda registrado en el panel.
 *
 * EXCEPCION deliberada: si entre los errores hay alguno de clase "internal"
 * (fallo nuestro — proveedor de COGS caido, binding sin configurar, excepcion
 * inesperada) se alerta igual aunque lo haya visto un solo agente. Con el
 * volumen actual del servidor, esperar a un segundo testigo de un fallo propio
 * es exactamente como se pierden 9 dias de CMS roto.
 *
 * Fase 25.11 — contar agentes distintos no bastaba. El 2026-09-21 un unico
 * agente automatizado (`anon:1bde233d85ac`, python-httpx, 838 llamadas en 24h
 * recorriendo URLs inventadas) genero el 80% del trafico del servidor, y con
 * el cualquier segundo agente que rozase la misma tool con UN error abria la
 * puerta: sonaron `csv_query` (7 errores suyos + 2 de otro) y `sitemap_parse`
 * (2 + 2), ambas falsas alarmas de 403/404 del destino. El mismo patron
 * aparece en las cuatro alertas de la ventana: 31+1+1, 4+1, 4+1, 141+1.
 *
 * El arreglo no es otro umbral de agentes sino medir lo que la alerta dice:
 * QUITA AL AGENTE QUE MAS ERRORES APORTA Y VUELVE A MIRAR. Si la tool sigue
 * rota sin el, esta rota para todo el mundo; si se arregla sola, era esa
 * sesion. Sobrevive a un agente que acapare el trafico, que es justo lo que
 * un umbral sobre la tasa agregada no puede hacer.
 *
 * Fase 25.12 — y un payer no es un agente. `payer` anonimo es un hash de la
 * IP, y el mismo cliente automatizado de 25.11 (python-httpx, `python-script`)
 * paso a salir por una IP nueva en cada llamada: 769 llamadas en 10 dias
 * repartidas entre 93 payers, casi todos con una sola. Apartar "al peor payer"
 * quitaba UNA de sus llamadas y el resto seguian pareciendo agentes distintos.
 * Sonaron cuatro alertas mas (23, 24 x2 y 30 de septiembre), todas `HTTP 530`
 * — el destino no resuelve en DNS — y todas suyas al 100%.
 *
 * Un agente anonimo se identifica por lo que declara ser (client_name + UA),
 * no por la IP desde la que llega. "Todo el mundo" pasa a significar clientes
 * DISTINTOS, no IPs distintas. Lo que se pierde a sabiendas: varios usuarios
 * anonimos del mismo cliente y version cuentan como uno, asi que una caida
 * que solo vea un tipo de cliente y que no sea de clase "internal" no suena.
 * Los payers identificados (wallet, cuenta) conservan su identidad propia.
 */
const BREAKAGE_MIN_PAYERS = 2;

/** Quien es el agente de una fila. Ver la nota de Fase 25.12 arriba. */
function agentKey(row: WindowRow, fallback: string): string {
  if (!row.payer) return fallback;
  if (!row.payer.startsWith("anon:")) return row.payer;
  // Sin nada declarado no hay con que agruparlo: se queda con su payer.
  if (!row.client_name && !row.client) return row.payer;
  return `anon|${row.client_name ?? ""}|${row.client ?? ""}`;
}
/**
 * Llamadas que deben quedar tras apartar al peor agente para que la tasa
 * restante signifique algo. Mas bajo que BREAKAGE_MIN_CALLS a proposito: una
 * caida real repartida entre 5 agentes con una llamada cada uno deja 4, y esa
 * si tiene que sonar.
 */
const BREAKAGE_MIN_CALLS_WITHOUT_TOP = 3;

/**
 * Fase 25.19 — el canario. Cuarta falsa alarma de esta familia tras 25.10,
 * 25.11 y 25.12, y la nota de 25.12 ya decia cual era el siguiente paso: no
 * otro umbral sino comprobar directamente lo que la alerta afirma.
 *
 * El 2026-10-21 sono `fetch_extract` 7/7 en 6 h, "3 agentes", clase
 * caller+upstream, 403 del destino. Los tres agentes eran el mismo escaner de
 * capacidades saliendo por la IP de Smithery (`anon:fc8c4578c711`) con dos
 * client_name (`python-script`, `phase-a`) y dos UAs (python-requests,
 * python-httpx): seis minutos recorriendo todas las tools con URLs que no
 * existen y cabeceras prohibidas. Apartar al peor agente dejaba 3/3 = 100 %.
 * Ningun otro cliente real toco la tool en la ventana, asi que no habia un
 * exito con el que contrastar; la tool respondia perfectamente.
 *
 * Cuando TODOS los errores son del llamante o del destino (ni uno `internal`),
 * la pregunta "esta rota la tool?" tiene una respuesta directa: que el propio
 * cron haga un fetch a una URL conocida por el mismo camino que usan las tools
 * (`safeFetch`). Si llega, la red de salida del Worker funciona y los errores
 * son lo que dicen ser: URLs malas. Si no llega, la alerta sale con esa prueba
 * anadida, que es justo lo que la vuelve accionable.
 *
 * Se decide ANTES del throttle para que una supresion no consuma la clave de
 * 12 h y tape una caida real una hora despues. Dos destinos por si uno cae; si
 * fallan los dos, se alerta. Solo se ejecuta cuando una tool ya parece rota,
 * asi que su coste es cero el 99 % de las pasadas.
 *
 * Lo que sigue sin cubrir: un fallo que sea nuestro y no pase por `safeFetch`
 * (parser, binding) sale como `internal` y pagina sin canario, como antes.
 */
const CANARY_URLS = ["https://www.cloudflare.com/robots.txt", "https://www.wikipedia.org/robots.txt"] as const;
const CANARY_TIMEOUT_MS = 10_000;
const CANARY_UA = "toolsnap-mcp/1.0 (health-canary; +https://toolsnap.app)";

/** Solo errores del llamante o del destino: el canario decide. Un `internal` pagina siempre. */
export function canaryDecides(kinds: string): boolean {
  const k = kinds.split("+");
  return k.includes("upstream") && !k.includes("internal");
}

export type CanaryFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface CanaryResult {
  ok: boolean;
  /** La URL que respondio, o el motivo por el que no respondio ninguna. */
  detail: string;
}

/** Un fetch de verdad por el camino de las tools. `ok` en cuanto UNA URL devuelve 2xx con cuerpo. */
export async function runFetchCanary(fetchImpl: CanaryFetch = (url, init) => safeFetch(url, init)): Promise<CanaryResult> {
  const failures: string[] = [];
  for (const url of CANARY_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": CANARY_UA } });
      const body = await res.text();
      if (res.ok && body.length > 0) return { ok: true, detail: url };
      failures.push(`${url} → HTTP ${res.status}${res.ok ? " (cuerpo vacio)" : ""}`);
    } catch (err) {
      failures.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, detail: failures.join("; ") };
}

export type BrokenTool = ReturnType<typeof findBrokenTools>[number];

/** Corre el canario UNA vez y solo si alguna tool rota lo pide; null cuando ninguna. */
export async function canaryFor(broken: ReadonlyArray<{ kinds: string }>, fetchImpl?: CanaryFetch): Promise<CanaryResult | null> {
  return broken.some((b) => canaryDecides(b.kinds)) ? runFetchCanary(fetchImpl) : null;
}

/**
 * Lo que el cron hace con una tool rota dado el canario: pagina salvo que los
 * errores sean solo del llamante/destino Y el canario haya llegado. Panel
 * (`health.broken_tools[].paged`) y pager comparten esta funcion, por la misma
 * razon que comparten findBrokenTools: si divergen, el panel miente.
 */
export function brokenToolPages(b: { kinds: string }, canary: CanaryResult | null): boolean {
  return !(canaryDecides(b.kinds) && canary?.ok === true);
}

/**
 * Silencio total. En los 14 dias previos al 2026-09-17 NO hubo ni una sola
 * hora sin eventos (minimo 15/h, mediana 27/h), asi que tres horas seguidas a
 * cero no es una racha tranquila: o el servidor no responde o la ruta de
 * escritura de analitica esta rota. Las dos cosas hay que mirarlas.
 */
const SILENCE_WINDOW_MS = 3 * HOUR_MS;
const SILENCE_DEDUPE_SEC = 6 * 60 * 60;
const SILENCE_FLAG_TTL_SEC = 7 * 24 * 60 * 60;
const SILENCE_FLAG_KEY = "health:silence:active";

export interface WindowRow {
  tool_name: string;
  payment_type: string;
  detail: string | null;
  client_name: string | null;
  client: string | null;
  /** Quien llamo. El agente sale de aqui y del cliente declarado (ver agentKey). */
  payer: string | null;
}

const D1_DOWN_DEDUPE_SEC = 60 * 60;

/** Deja alertar una sola vez por ventana TTL. Sin KV alerta igualmente (best effort). */
async function shouldAlert(kv: KVNamespace | undefined, key: string, ttlSec: number): Promise<boolean> {
  if (!kv) return true;
  try {
    if (await kv.get(key)) return false;
    await kv.put(key, "1", { expirationTtl: ttlSec });
  } catch (err) {
    // Fase 25.14 — sin KV (cuota diaria agotada) se avisa igualmente.
    console.warn("health throttle KV failed:", err instanceof Error ? err.message : String(err));
  }
  return true;
}

/**
 * Tools cuya tasa de error entre llamantes REALES (sin escaneres, sin trafico
 * interno) ha cruzado el umbral en la ventana. Devuelve tambien el detail mas
 * repetido, que es lo que convierte la alerta en accionable.
 */
export function findBrokenTools(rows: WindowRow[]): Array<{
  tool: string;
  total: number;
  errors: number;
  pct: number;
  payers: number;
  topDetail: string | null;
  kinds: string;
}> {
  const byTool = new Map<
    string,
    {
      total: number;
      errors: number;
      details: Map<string, number>;
      kinds: Set<string>;
      errorPayers: Set<string>;
      /** Llamadas y errores de cada agente: el reparto que pide Fase 25.11. */
      byPayer: Map<string, { calls: number; errors: number }>;
    }
  >();

  for (const row of rows) {
    // Los escaneres de directorios llaman a proposito sin argumentos: incluirlos
    // haria que toda tool "de catalogo" pareciese rota permanentemente.
    if (isProbeClient(row.client_name, row.client)) continue;
    const agg = byTool.get(row.tool_name) ?? {
      total: 0,
      errors: 0,
      details: new Map<string, number>(),
      kinds: new Set<string>(),
      errorPayers: new Set<string>(),
      byPayer: new Map(),
    };
    agg.total += 1;
    // Sin payer (no deberia pasar: la columna es NOT NULL) cada fila cuenta
    // como un agente distinto — no callar una alerta por un dato ausente.
    const who = agentKey(row, `(desconocido:${agg.total})`);
    const mine = agg.byPayer.get(who) ?? { calls: 0, errors: 0 };
    mine.calls += 1;
    if (row.payment_type === "tool_error") {
      agg.errors += 1;
      mine.errors += 1;
      agg.kinds.add(classifyToolError(row.detail));
      agg.errorPayers.add(who);
      const d = row.detail ?? "(sin detalle)";
      agg.details.set(d, (agg.details.get(d) ?? 0) + 1);
    }
    agg.byPayer.set(who, mine);
    byTool.set(row.tool_name, agg);
  }

  const broken = [];
  for (const [tool, agg] of byTool) {
    if (agg.total < BREAKAGE_MIN_CALLS) continue;
    const pct = Math.round((agg.errors / agg.total) * 100);
    if (pct < BREAKAGE_PCT) continue;
    if (!agg.kinds.has("internal")) {
      if (agg.errorPayers.size < BREAKAGE_MIN_PAYERS) continue;
      // Fase 25.11: aparta al agente que mas errores aporta y vuelve a mirar.
      // Si la tool deja de parecer rota sin el, no estaba rota: era su sesion.
      const worst = Array.from(agg.byPayer.values()).sort((a, b) => b.errors - a.errors)[0];
      const restCalls = agg.total - (worst?.calls ?? 0);
      const restErrors = agg.errors - (worst?.errors ?? 0);
      if (restCalls < BREAKAGE_MIN_CALLS_WITHOUT_TOP) continue;
      if ((restErrors / restCalls) * 100 < BREAKAGE_PCT) continue;
    }
    const topDetail =
      Array.from(agg.details.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    broken.push({
      tool,
      total: agg.total,
      errors: agg.errors,
      pct,
      payers: agg.errorPayers.size,
      topDetail,
      kinds: Array.from(agg.kinds).sort().join("+") || "—",
    });
  }
  return broken.sort((a, b) => b.errors - a.errors);
}

/**
 * Fase 25.17 — las filas de la ventana de vigilancia (6 h, solo llamadas
 * reales y no internas). UNA sola consulta compartida: el cron la pasa por
 * findBrokenTools para alertar y el panel de /analytics por el mismo
 * findBrokenTools para mostrar lo que ahora mismo esta roto. Si el SQL viviera
 * en dos sitios, panel y pager acabarian discrepando sobre que es "una tool
 * rota" (justo lo que Fase 25.15 arreglo para our_errors).
 */
export async function loadHealthWindow(db: D1Database, now: number): Promise<WindowRow[]> {
  const res = await db
    .prepare(
      `SELECT tool_name, payment_type, detail, client_name, client, payer
         FROM analytics_events
        WHERE ts >= ? AND payment_type <> 'connect' AND internal = 0
        LIMIT 5000`
    )
    .bind(now - BREAKAGE_WINDOW_MS)
    .all<WindowRow>();
  return res.results ?? [];
}

export async function checkServerHealth(env: Env, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();

  let windowRows: Awaited<ReturnType<typeof loadHealthWindow>>;
  let silence: { n: number } | null;
  try {
    [windowRows, silence] = await Promise.all([
      loadHealthWindow(env.PREPAID_DB, nowMs),
      env.PREPAID_DB.prepare(`SELECT count(*) AS n FROM analytics_events WHERE ts >= ?`)
        .bind(nowMs - SILENCE_WINDOW_MS)
        .first<{ n: number }>(),
    ]);
  } catch (err) {
    if (!isD1Unavailable(err)) throw err;
    // Fase E — D1 sin cuota: un solo aviso por hora, sin relanzar (no es un
    // fallo del cron en si y no debe disparar tambien el aviso de cron).
    console.warn("health: D1 unavailable:", err instanceof Error ? err.message : String(err));
    if (await shouldAlert(env.X402_NONCES, "health:d1-unavailable", D1_DOWN_DEDUPE_SEC)) {
      await sendTelegram(
        env,
        [
          `🔴 *D1 sin cuota / no disponible*`,
          `Las consultas a D1 fallan (${err instanceof Error ? err.message.slice(0, 160) : "error"}).`,
          `OAuth, prepago y panel responden 503/-32000; las tools gratuitas siguen. La cuota se repone a las 00:00 UTC.`,
        ].join("\n")
      ).catch(() => {});
    }
    return;
  }

  // --- 1. Silencio ---------------------------------------------------------
  const eventsInWindow = silence?.n ?? 0;
  if (eventsInWindow === 0) {
    await env.X402_NONCES.put(SILENCE_FLAG_KEY, String(nowMs), {
      expirationTtl: SILENCE_FLAG_TTL_SEC,
    }).catch((err: unknown) => {
      // Fase 25.14 — best-effort: sin la marca solo se pierde el "restablecido".
      console.warn("health silence flag KV write failed:", err instanceof Error ? err.message : String(err));
    });
    if (await shouldAlert(env.X402_NONCES, "health:silence:alert", SILENCE_DEDUPE_SEC)) {
      await sendTelegram(
        env,
        [
          `🔴 *ToolSnap sin trafico*`,
          `Ni un solo evento en las ultimas ${SILENCE_WINDOW_MS / HOUR_MS}h.`,
          `Lo normal son 15-30/h sin bajar nunca a cero, asi que esto apunta a servidor caido, ruta rota o la escritura de analitica fallando.`,
          `Comprueba https://mcp.toolsnap.app/mcp y los logs del Worker (wrangler tail).`,
        ].join("\n")
      );
    }
  } else if (await env.X402_NONCES.get(SILENCE_FLAG_KEY)) {
    // Solo puede sonar despues de un corte real: avisa de que ya paso.
    await env.X402_NONCES.delete(SILENCE_FLAG_KEY);
    await sendTelegram(env, `✅ *ToolSnap* — trafico restablecido (${eventsInWindow} eventos en las ultimas ${SILENCE_WINDOW_MS / HOUR_MS}h).`);
  }

  // --- 2. Tools rotas ------------------------------------------------------
  // Fase 25.19 — un solo canario por pasada, y solo si alguna tool lo pide.
  const broken = findBrokenTools(windowRows);
  const canary = await canaryFor(broken);
  for (const b of broken) {
    if (!brokenToolPages(b, canary)) {
      console.warn(
        `health: ${b.tool} ${b.errors}/${b.total} (${b.kinds}) pero el canario responde (${canary?.detail}): URLs del llamante, no se pagina`
      );
      continue;
    }
    if (!(await shouldAlert(env.X402_NONCES, `health:broken:${b.tool}`, BREAKAGE_DEDUPE_SEC))) continue;
    await sendTelegram(
      env,
      [
        `🔴 *tool fallando para todo el mundo* · \`${b.tool}\``,
        `${b.errors}/${b.total} llamadas reales fallidas en ${BREAKAGE_WINDOW_MS / HOUR_MS}h (*${b.pct}%*)`,
        `agentes afectados: ${b.payers}`,
        `clase: ${b.kinds}`,
        b.topDetail ? `detail mas comun: ${b.topDetail}` : null,
        canary && !canary.ok ? `canario: el fetch saliente del Worker tampoco llega (${canary.detail})` : null,
        b.kinds === "caller"
          ? `Todos son errores de argumentos: el esquema o la descripcion de la tool esta induciendo a los agentes a llamarla mal. Toca ajustar el MCP.`
          : null,
      ]
        .filter((l): l is string => l !== null)
        .join("\n")
    );
  }
}
