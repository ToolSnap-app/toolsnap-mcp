/**
 * Fase 25.17 — marca de "ultimo OK / ultimo error" por tarea del cron, para el
 * panel de /analytics. Un cron que revienta ya avisa por Telegram (runTask en
 * index.ts); lo que faltaba era poder MIRAR el estado sin esperar a que suene.
 *
 * Todo es KV best-effort (X402_NONCES, el unico KV): un KV agotado o ausente
 * nunca tumba una tarea ni el panel. Y el presupuesto de puts importa: el KV
 * free son 1.000 puts/dia y ya se agoto una vez (Fase 25.14), asi que NO se
 * escribe en cada pasada de un cron de 5 minutos (serian ~580/dia):
 *   - exito: lee las dos claves (las lecturas son baratas), borra el error si
 *     lo hay (el estado actual es "bien") y reescribe last_ok como mucho una
 *     vez por hora -> ~50 puts/dia en total entre las seis tareas;
 *   - error: como mucho un put cada 30 minutos con el mismo mensaje.
 */

/** Las tareas de scheduled() en src/index.ts, en el orden en que las pinta el panel. */
export const CRON_TASK_NAMES = [
  "x-agent-publisher",
  "health",
  "usage-alerts",
  "surface-digest",
  "x-agent-metrics",
  "directory-stats",
  "analytics-daily",
] as const;

export interface CronStatus {
  name: string;
  last_ok_ts: number | null;
  last_error: string | null;
  last_error_ts: number | null;
  /** Fallo conocido y ya avisado aparte (creditos de X agotados): se ve, pero no tiñe el panel de rojo. */
  muted: boolean;
}

const KEY_OK = (name: string): string => `cron:last_ok:${name}`;
const KEY_ERR = (name: string): string => `cron:last_error:${name}`;
const TTL_SEC = 14 * 24 * 60 * 60;
const OK_REWRITE_MS = 60 * 60 * 1000;
const ERROR_REWRITE_MS = 30 * 60 * 1000;
const MAX_MESSAGE_CHARS = 300;

interface StoredError {
  ts: number;
  message: string;
  muted: boolean;
}

function parseError(raw: string | null): StoredError | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredError>;
    if (typeof v.ts === "number" && typeof v.message === "string") {
      return { ts: v.ts, message: v.message, muted: v.muted === true };
    }
  } catch {
    // Valor ajeno al formato: se trata como ausente.
  }
  return null;
}

/** La tarea termino bien. Nunca lanza. */
export async function recordCronOk(kv: KVNamespace | undefined, name: string, now = Date.now()): Promise<void> {
  if (!kv) return;
  try {
    const [okRaw, errRaw] = await Promise.all([kv.get(KEY_OK(name)), kv.get(KEY_ERR(name))]);
    if (errRaw) await kv.delete(KEY_ERR(name));
    const lastOk = okRaw ? Number(okRaw) : 0;
    if (errRaw || !Number.isFinite(lastOk) || now - lastOk >= OK_REWRITE_MS) {
      await kv.put(KEY_OK(name), String(now), { expirationTtl: TTL_SEC });
    }
  } catch (err) {
    console.warn("cron status KV write failed:", err instanceof Error ? err.message : String(err));
  }
}

/** La tarea fallo. Nunca lanza. */
export async function recordCronError(
  kv: KVNamespace | undefined,
  name: string,
  message: string,
  muted = false,
  now = Date.now()
): Promise<void> {
  if (!kv) return;
  try {
    const text = message.slice(0, MAX_MESSAGE_CHARS);
    const prev = parseError(await kv.get(KEY_ERR(name)));
    if (prev && prev.message === text && now - prev.ts < ERROR_REWRITE_MS) return;
    const value: StoredError = { ts: now, message: text, muted };
    await kv.put(KEY_ERR(name), JSON.stringify(value), { expirationTtl: TTL_SEC });
  } catch (err) {
    console.warn("cron status KV write failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Lo que lee el panel. Un KV ausente o roto devuelve todo a null: el panel no se cae por esto. */
export async function readCronStatuses(kv: KVNamespace | undefined): Promise<CronStatus[]> {
  return Promise.all(
    CRON_TASK_NAMES.map(async (name): Promise<CronStatus> => {
      const empty: CronStatus = { name, last_ok_ts: null, last_error: null, last_error_ts: null, muted: false };
      if (!kv) return empty;
      try {
        const [okRaw, errRaw] = await Promise.all([kv.get(KEY_OK(name)), kv.get(KEY_ERR(name))]);
        const ok = okRaw ? Number(okRaw) : NaN;
        const err = parseError(errRaw);
        return {
          name,
          last_ok_ts: Number.isFinite(ok) ? ok : null,
          last_error: err?.message ?? null,
          last_error_ts: err?.ts ?? null,
          muted: err?.muted ?? false,
        };
      } catch (e) {
        console.warn("cron status KV read failed:", e instanceof Error ? e.message : String(e));
        return empty;
      }
    })
  );
}
