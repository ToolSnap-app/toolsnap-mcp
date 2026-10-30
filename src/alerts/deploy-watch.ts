import type { Env } from "../index.js";
import { sendTelegram } from "./telegram.js";

/**
 * Accion A14 del plan de seguridad (2026-10): avisar de los despliegues que no
 * salgan del workflow. El socio puede publicar sin aprobacion, asi que el
 * control no es impedirlo sino enterarse.
 *
 * Mecanismo:
 *  - El workflow de deploy (y scripts/registrar-deploy.sh a mano) escribe en KV
 *    `esperado:{worker}:dep:{deploymentId}` justo despues de `wrangler deploy`.
 *    Se registra el DEPLOYMENT, no la version: un `wrangler rollback` crea un
 *    deployment nuevo con una version ya conocida, y eso es justo un
 *    despliegue fuera del workflow.
 *  - Este cron lee los ultimos deployments de cada Worker vigilado con un token
 *    de SOLO LECTURA (VIGIA_CF_TOKEN) y avisa por Telegram (el mismo canal que
 *    ya usan las alertas de error) de cualquier deployment nuevo no
 *    registrado como esperado y de todo rollback.
 *
 * KV: se reutiliza X402_NONCES (el unico binding). Presupuesto: lecturas
 * ~4 por pasada (despreciable frente a 100.000/dia) y puts SOLO cuando cambia
 * el ultimo deployment visto (unos pocos al dia), muy lejos de los 1.000
 * puts/dia que ya se agotaron una vez (Fase 25.14).
 *
 * Corre en el trigger de 5 minutos que ya existe: un trigger nuevo cuenta
 * contra el limite de crons por cuenta del plan free.
 */

const API = "https://api.cloudflare.com/client/v4";
/** Un deploy recien hecho puede ver este cron antes de que el workflow termine de registrarlo. */
const GRACE_MS = 3 * 60 * 1000;
const MAX_ALERTS_PER_WORKER = 5;
/** Un aviso que lleva tanto sin poder enviarse deja de reintentarse en silencio: se lanza para que runTask lo pagine. */
const UNDELIVERABLE_MS = 60 * 60 * 1000;

export interface DeploymentVersion {
  version_id: string;
  percentage?: number;
}

export interface Deployment {
  id: string;
  created_on: string;
  source?: string;
  author_email?: string;
  annotations?: Record<string, string>;
  versions?: DeploymentVersion[];
}

export type Verdict = "baseline" | "unchanged" | "expected" | "unexpected" | "pending";

export const seenKey = (worker: string): string => `ultimo-visto:${worker}`;
export const expectedKey = (worker: string, deploymentId: string): string => `esperado:${worker}:dep:${deploymentId}`;

/**
 * Decide que hacer con un deployment dado el ultimo visto. Pura: la parte con
 * dinero de verdad (cuando callar y cuando gritar) vive aqui para poder
 * probarla sin red.
 *  - baseline:   no hay estado previo, solo se guarda.
 *  - unchanged:  es el mismo deployment ya visto.
 *  - expected:   nuevo y registrado como esperado.
 *  - pending:    nuevo, sin registrar, pero tan reciente que el workflow puede
 *                estar todavia registrandolo: se reevalua en la siguiente pasada.
 *  - unexpected: nuevo y sin registrar, o un rollback (siempre avisa, este o no
 *                registrado, y sin margen de cortesia): alerta.
 */
export function judgeDeployment(
  deployment: Deployment,
  lastSeenId: string | null,
  registered: boolean,
  now: number
): Verdict {
  if (lastSeenId === null) return "baseline";
  if (deployment.id === lastSeenId) return "unchanged";
  if (deployment.annotations?.["workers/triggered_by"] === "rollback") return "unexpected";
  if (registered) return "expected";
  const created = Date.parse(deployment.created_on);
  if (Number.isFinite(created) && now - created < GRACE_MS) return "pending";
  return "unexpected";
}

/**
 * Deployments posteriores al ultimo visto, del mas antiguo al mas reciente. La
 * API los devuelve del mas reciente al mas antiguo; si el ultimo visto ya no
 * esta en la lista se miran todos los devueltos.
 */
export function newerThan(deployments: Deployment[], lastSeenId: string | null): Deployment[] {
  if (lastSeenId === null) return [];
  const idx = deployments.findIndex((d) => d.id === lastSeenId);
  const fresh = idx === -1 ? deployments : deployments.slice(0, idx);
  return [...fresh].reverse();
}

async function fetchDeployments(accountId: string, worker: string, token: string): Promise<Deployment[]> {
  const res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker)}/deployments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`deployments ${worker}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: { deployments?: Deployment[] } };
  return body.result?.deployments ?? [];
}

/**
 * Texto libre de terceros dentro de un bloque de codigo del Markdown LEGADO de
 * Telegram (el que usa sendTelegram). Fuera de los backticks no puede haber un
 * `_`, `*` o `[` suelto: Telegram contesta 400 "can't parse entities" y la
 * alerta no sale (revision de la PR #144). Por eso las etiquetas van sin `_`.
 */
const code = (s: string | undefined): string => `\`${(s ?? "-").replace(/`/g, "'").slice(0, 200)}\``;

export function formatAlert(worker: string, d: Deployment, more = 0): string {
  const a = d.annotations ?? {};
  const rollback = a["workers/triggered_by"] === "rollback";
  const ids = (d.versions ?? []).map((v) => v.version_id).join(", ");
  const lines = [
    `🔴 *${rollback ? "Rollback" : "Despliegue inesperado"}* · ${code(worker)}`,
    `deployment: ${code(d.id)}`,
    `version: ${code(ids || "-")}`,
    `fecha: ${code(d.created_on)}`,
    `autor: ${code(d.author_email)}`,
    `origen: ${code(d.source)}`,
    `disparado por: ${code(a["workers/triggered_by"])}`,
  ];
  if (a["workers/message"]) lines.push(`mensaje: ${code(a["workers/message"])}`);
  lines.push(
    rollback
      ? "Un rollback siempre avisa, lo haya hecho el workflow o no."
      : "No lo registro el workflow ni scripts/registrar-deploy.sh."
  );
  if (more > 0) lines.push(`y ${more} más`);
  return lines.join("\n");
}

/**
 * Una pasada de vigilancia. Sin VIGIA_CF_TOKEN no hace nada (se puede
 * desplegar antes de poner el secret). Un fallo de la API lanza para que
 * runTask lo pagine como cualquier cron roto; un KV roto nunca provoca falsas
 * alertas: sin leer el estado no se decide nada.
 */
export async function checkDeployWatch(env: Env, now = Date.now()): Promise<void> {
  const token = env.VIGIA_CF_TOKEN;
  const accountId = env.VIGIA_ACCOUNT_ID;
  if (!token || !accountId) return;
  const workers = (env.VIGIA_WORKERS ?? "toolsnap-mcp,toolsnap-portal")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  const kv = env.X402_NONCES;

  const failures: string[] = [];
  for (const worker of workers) {
    try {
      const deployments = await fetchDeployments(accountId, worker, token);
      if (deployments.length === 0) continue;
      const latest = deployments[0]!;
      const lastSeen = await kv.get(seenKey(worker));

      // Primera ejecucion sin estado: solo guardar.
      if (lastSeen === null) {
        await kv.put(seenKey(worker), latest.id);
        continue;
      }

      // Pasada 1: veredicto de cada deployment nuevo, del mas antiguo al mas
      // reciente. Uno pendiente (muy reciente y sin registrar) corta: se
      // reevalua en la siguiente pasada, y los posteriores con el.
      const fresh = newerThan(deployments, lastSeen);
      const judged: Array<{ d: Deployment; verdict: Verdict }> = [];
      for (const d of fresh) {
        const registered = (await kv.get(expectedKey(worker, d.id))) !== null;
        const verdict = judgeDeployment(d, lastSeen, registered, now);
        if (verdict === "pending") break;
        judged.push({ d, verdict });
      }

      // Pasada 2: avisar de los inesperados (maximo MAX_ALERTS_PER_WORKER; el
      // ultimo aviso lleva "y N más") y avanzar `ultimo-visto`.
      const unexpected = judged.filter((j) => j.verdict === "unexpected");
      const extra = Math.max(0, unexpected.length - MAX_ALERTS_PER_WORKER);
      let newSeen = lastSeen;
      let sentCount = 0;
      let stopped = false;
      for (const { d, verdict } of judged) {
        if (verdict === "unexpected" && sentCount < MAX_ALERTS_PER_WORKER) {
          sentCount++;
          const last = sentCount === MAX_ALERTS_PER_WORKER;
          const sent = await sendTelegram(env, formatAlert(worker, d, last ? extra : 0));
          if (!sent) {
            // No se da por visto: se reintenta en la siguiente pasada, pero no
            // en silencio (revision de la PR #144: un envio que falla para
            // siempre no puede quedarse sin rastro).
            console.warn(`deploy-watch: no se pudo enviar el aviso de ${worker} (deployment ${d.id})`);
            const age = now - Date.parse(d.created_on);
            if (Number.isFinite(age) && age > UNDELIVERABLE_MS) {
              throw new Error(`aviso de ${worker} sin poder enviarse desde hace mas de 1 h (deployment ${d.id})`);
            }
            stopped = true;
            break;
          }
        }
        newSeen = d.id;
      }
      // Sin pendientes ni envios fallidos, `ultimo-visto` salta al mas reciente.
      if (!stopped && judged.length === fresh.length) newSeen = latest.id;
      if (newSeen !== lastSeen) await kv.put(seenKey(worker), newSeen);
    } catch (err) {
      failures.push(`${worker}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length) throw new Error(`deploy-watch: ${failures.join("; ")}`);
}
