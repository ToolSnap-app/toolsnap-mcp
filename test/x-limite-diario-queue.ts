/**
 * Cola de X con el tope diario de toolsnap-x-personal: un `limite-diario` no
 * deja la fila `failed` (eso bloquearia los hijos de un hilo): la reprograma a
 * las 00:00 UTC del dia siguiente sin gastar intento. Un 4xx normal sigue
 * dejandola `failed`, y una respuesta (kind='reply') no se pospone.
 *
 * D1 se simula con SQLite real (node:sqlite) y el esquema de la migracion
 * 0009; solo el binding X_PERSONAL es un stub. Run: npx tsx test/x-limite-diario-queue.ts
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { attemptPublishNow, type PublishOneEnv } from "../src/x-agent/publish-one.js";
import { getDueRows, getQueueRow } from "../src/x-agent/queue.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  OK   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../migrations/0009_x_agent.sql", import.meta.url), "utf8"));
const db = {
  prepare(q: string) {
    return {
      bind(...b: unknown[]) {
        return {
          first: async () => (sqlite.prepare(q).get(...(b as never[])) as never) ?? null,
          run: async () => ({ meta: { changes: Number(sqlite.prepare(q).run(...(b as never[])).changes) } }),
          all: async () => ({ results: sqlite.prepare(q).all(...(b as never[])) }),
        };
      },
    };
  },
} as unknown as D1Database;

let answer: { ok: boolean; message?: string; status?: number; retryable?: boolean; code?: string } = { ok: true };
const env = {
  PREPAID_DB: db,
  X_PERSONAL: {
    publish: async () => (answer.ok ? { ok: true, value: { tweetId: "1850000000000000001" } } : answer),
    uploadMedia: async () => ({ ok: false, message: "n/a", status: 0, retryable: false }),
    repost: async () => answer,
  },
} as unknown as PublishOneEnv;

const nowTs = Math.floor(Date.now() / 1000);
function addRow(kind: string, dependsOn: number | null = null): number {
  const r = sqlite
    .prepare("INSERT INTO x_queue (account, kind, text, status, scheduled_at, depends_on, min_gap_s, approval_mode) VALUES ('personal', ?, 'hola', 'scheduled', ?, ?, 0, 'auto')")
    .run(kind, nowTs - 60, dependsOn);
  return Number(r.lastInsertRowid);
}

const capped = { ok: false, message: "x-personal: limite-diario: 15", status: 429, retryable: false, code: "limite-diario" };
const midnight = (Math.floor(nowTs / 86400) + 1) * 86400;

console.log("\nlimite-diario en la cola");
const parent = addRow("thread_part");
const child = addRow("thread_part", parent);
answer = capped;
let res = await attemptPublishNow(env, (await getQueueRow(db, parent))!);
let row = (await getQueueRow(db, parent))!;
assert(res.status === "deferred", "el tope devuelve 'deferred', no 'failed'");
assert(row.status === "scheduled" && row.scheduled_at === midnight, "la fila vuelve a 'scheduled' a las 00:00 UTC del dia siguiente");
assert(row.attempt_count === 0, "sin consumir intento");
assert(/limite-diario/.test(row.error ?? ""), "guarda el motivo en error");
assert((await getQueueRow(db, child))!.status === "scheduled", "el hijo del hilo NO queda bloqueado");
assert((await getDueRows(db)).length === 0, "no vuelve a salir en lo que queda de dia");

const plain = addRow("post");
answer = { ok: false, message: "X API error (403): duplicate", status: 403, retryable: false };
res = await attemptPublishNow(env, (await getQueueRow(db, plain))!);
assert(res.status === "failed" && (await getQueueRow(db, plain))!.status === "failed", "un 4xx normal sigue dejando la fila 'failed'");

const reply = addRow("reply");
answer = capped;
res = await attemptPublishNow(env, (await getQueueRow(db, reply))!);
assert(res.status === "failed" && (await getQueueRow(db, reply))!.status === "failed", "una respuesta (kind='reply') no se pospone: falla");

console.log(failures === 0 ? "\nAll x-limite-diario-queue checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
