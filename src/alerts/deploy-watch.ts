import type { Env } from "../index.js";
import { sendTelegram } from "./telegram.js";

/**
 * Accion A14 del plan de seguridad (2026-10): avisar de los despliegues que no
 * salgan del workflow. El socio puede publicar sin aprobacion, asi que el
 * control no es impedirlo sino enterarse.
 *
 * Mecanismo:
 *  - El workflow de deploy (y scripts/registrar-deploy.sh a mano) escribe en KV
 *    `esperado:{worker}:{versionId}` justo despues de `wrangler deploy`.
 *  - Este cron lee los ultimos deployments de cada Worker vigilado con un token
 *    de SOLO LECTURA (VIGIA_CF_TOKEN) y avisa por Telegram (el mismo canal que
 *    ya usan las alertas de error) de cualquier deployment nuevo cuyas
 *    versiones no esten registradas como esperadas.
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
export const expectedKey = (worker: string, versionId: string): string => `esperado:${worker}:${versionId}`;

/**
 * Decide que hacer con un deployment dado el ultimo visto. Pura: la parte con
 * dinero de verdad (cuando callar y cuando gritar) vive aqui para poder
 * probarla sin red.
 *  - baseline:   no hay estado previo, solo se guarda.
 *  - unchanged:  es el mismo deployment ya visto.
 *  - expected:   nuevo, y todas sus versiones estan registradas.
 *  - pending:    nuevo, sin registrar, pero tan reciente que el workflow puede
 *                estar todavia registrandolo: se reevalua en la siguiente pasada.
 *  - unexpected: nuevo y sin registrar: alerta.
 */
export function judgeDeployment(
  deployment: Deployment,
  lastSeenId: string | null,
  allVersionsRegistered: boolean,
  now: number
): Verdict {
  if (lastSeenId === null) return "baseline";
  if (deployment.id === lastSeenId) return "unchanged";
  if (allVersionsRegistered) return "expected";
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

/** Texto libre de terceros dentro de un bloque de codigo de Markdown de Telegram. */
const code = (s: string | undefined): string => `\`${(s ?? "-").replace(/`/g, "'").slice(0, 200)}\``;

export function formatAlert(worker: string, d: Deployment): string {
  const a = d.annotations ?? {};
  const ids = (d.versions ?? []).map((v) => v.version_id).join(", ");
  const lines = [
    `🔴 *Despliegue inesperado* · ${code(worker)}`,
    `version: ${code(ids || d.id)}`,
    `fecha: ${code(d.created_on)}`,
    `autor: ${code(d.author_email)}`,
    `source: ${code(d.source)}`,
    `triggered_by: ${code(a["workers/triggered_by"])}`,
  ];
  if (a["workers/message"]) lines.push(`mensaje: ${code(a["workers/message"])}`);
  if (a["workers/tag"]) lines.push(`tag: ${code(a["workers/tag"])}`);
  lines.push("No lo registro el workflow ni scripts/registrar-deploy.sh.");
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

      let newSeen = lastSeen;
      let blocked = false;
      let alerts = 0;
      for (const d of newerThan(deployments, lastSeen)) {
        const versionIds = (d.versions ?? []).map((v) => v.version_id);
        const registered =
          versionIds.length > 0 &&
          (await Promise.all(versionIds.map((v) => kv.get(expectedKey(worker, v))))).every((v) => v !== null);
        const verdict = judgeDeployment(d, lastSeen, registered, now);
        if (verdict === "pending") {
          // No se avanza mas alla de un deployment pendiente: se reevalua.
          blocked = true;
          break;
        }
        if (verdict === "unexpected") {
          alerts++;
          if (alerts <= MAX_ALERTS_PER_WORKER) {
            const sent = await sendTelegram(env, formatAlert(worker, d));
            // Si el aviso no sale, no se da por visto: se reintenta en la siguiente pasada.
            if (!sent) {
              blocked = true;
              break;
            }
          }
        }
        newSeen = d.id;
      }
      if (!blocked) newSeen = latest.id;
      if (newSeen !== lastSeen) await kv.put(seenKey(worker), newSeen);
    } catch (err) {
      failures.push(`${worker}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length) throw new Error(`deploy-watch: ${failures.join("; ")}`);
}
