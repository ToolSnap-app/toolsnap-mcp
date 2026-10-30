/**
 * Tope diario de publicaciones de toolsnap-x-personal (2026-10-30, decision de
 * Unai: 15 al dia). Si toolsnap-mcp se viera comprometido, lo peor que puede
 * hacer con el token personal es gastar este tope, no inundar la cuenta.
 *
 * Un Durable Object con SQLite y una sola instancia (el nombre fijo
 * LIMITER_NAME lo pone ops.ts): el Worker no tiene almacenamiento propio y
 * cualquier contador por isolate o por colo se saltaria de largo. Un DO
 * procesa sus llamadas de una en una y los metodos de abajo son sincronos, asi
 * que "leer, comparar y sumar" es atomico sin bloqueos.
 *
 * Sin `fetch` a proposito: el DO solo lo alcanza el Worker que lo declara
 * (binding LIMITE_PUBLICACIONES) y por sus dos metodos RPC; no hay URL, ni
 * clase RPC expuesta a otros Workers (esa es XPersonal).
 */
import { DurableObject } from "cloudflare:workers";

/** Hasta cuantos dias de historial se guardan (el contador solo lee el de hoy). */
const RETENCION_DIAS = 60;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export interface Reserva {
  /** false si el tope ya estaba alcanzado: no se ha sumado nada. */
  ok: boolean;
  /** Publicaciones contadas hoy tras la llamada. */
  usadas: number;
}

function validar(dia: unknown): asserts dia is string {
  if (typeof dia !== "string" || !DIA.test(dia)) throw new Error("dia debe ser AAAA-MM-DD");
}

export class PublicationLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS uso (dia TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  }

  /** Cuenta una publicacion en `dia` (UTC) si no se ha llegado a `tope`. */
  reservar(dia: string, tope: number): Reserva {
    validar(dia);
    if (!Number.isInteger(tope) || tope < 1 || tope > 1000) throw new Error("tope fuera de rango");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const actual = Number(sql.exec("SELECT n FROM uso WHERE dia = ?", dia).toArray()[0]?.n ?? 0);
      if (actual >= tope) return { ok: false, usadas: actual };
      sql.exec(
        "INSERT INTO uso (dia, n) VALUES (?, 1) ON CONFLICT(dia) DO UPDATE SET n = n + 1",
        dia
      );
      const limite = new Date(Date.parse(`${dia}T00:00:00Z`) - RETENCION_DIAS * 86_400_000).toISOString().slice(0, 10);
      sql.exec("DELETE FROM uso WHERE dia < ?", limite);
      return { ok: true, usadas: actual + 1 };
    });
  }

  /** Devuelve una reserva cuando X rechazo la publicacion (no se publico nada). */
  liberar(dia: string): void {
    validar(dia);
    this.ctx.storage.sql.exec("UPDATE uso SET n = n - 1 WHERE dia = ? AND n > 0", dia);
  }
}
