/**
 * Tope diario de publicaciones de toolsnap-x-personal (2026-10-30, decision de
 * Unai: 15 al dia). Si toolsnap-mcp se viera comprometido, lo peor que puede
 * hacer con el token personal es gastar este tope, no inundar la cuenta.
 *
 * Un Durable Object con SQLite y una sola instancia (el nombre fijo
 * LIMITER_NAME lo pone ops.ts): el Worker no tiene almacenamiento propio y
 * cualquier contador por isolate o por colo se saltaria de largo. Los metodos
 * de abajo son sincronos y el runtime del DO atiende las llamadas de una en
 * una, asi que "contar, comparar y sumar" es atomico sin bloqueos.
 *
 * Quien alcanza el DO: este Worker por su binding LIMITE_PUBLICACIONES, pero
 * NO en exclusiva. Cualquier Worker de la cuenta con permiso de deploy puede
 * declarar un binding a esta clase con `script_name: "toolsnap-x-personal"` y
 * llamar a estos dos metodos. Por eso el diseno no se apoya en el secreto del
 * binding sino en lo que cada metodo permite hacer:
 *   - `reservar` desde fuera solo GASTA cupo: es inocuo para las cuentas (no
 *     publica nada) y como mucho consume el tope del dia (denegacion de
 *     servicio al tope, que ya es el limite de dano).
 *   - `liberar` exige el `nonce` de una reserva concreta y de un solo uso:
 *     un tercero solo puede devolver lo que el mismo reservo, nunca bajar el
 *     contador por debajo de las reservas de otros.
 * El DO no tiene `fetch`: no hay URL ni acceso HTTP.
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
  /** Solo si ok: la reserva, para devolverla con `liberar` (una vez). */
  nonce?: string;
}

function validar(dia: unknown): asserts dia is string {
  if (typeof dia !== "string" || !DIA.test(dia)) throw new Error("dia debe ser AAAA-MM-DD");
}

export class PublicationLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // Una fila por reserva: el contador del dia es el numero de filas, y
    // devolver una reserva es borrar su fila (solo existe una vez).
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reservas (nonce TEXT PRIMARY KEY, dia TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS reservas_dia ON reservas (dia)");
  }

  /** Cuenta una publicacion en `dia` (UTC) si no se ha llegado a `tope`. */
  reservar(dia: string, tope: number): Reserva {
    validar(dia);
    if (!Number.isInteger(tope) || tope < 1 || tope > 1000) throw new Error("tope fuera de rango");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const actual = Number(sql.exec("SELECT COUNT(*) AS n FROM reservas WHERE dia = ?", dia).toArray()[0]?.n ?? 0);
      if (actual >= tope) return { ok: false, usadas: actual };
      const nonce = crypto.randomUUID();
      sql.exec("INSERT INTO reservas (nonce, dia) VALUES (?, ?)", nonce, dia);
      const limite = new Date(Date.parse(`${dia}T00:00:00Z`) - RETENCION_DIAS * 86_400_000).toISOString().slice(0, 10);
      sql.exec("DELETE FROM reservas WHERE dia < ?", limite);
      return { ok: true, usadas: actual + 1, nonce };
    });
  }

  /** Devuelve una reserva propia (X rechazo la publicacion: no se publico nada). Un nonce desconocido o ya devuelto no hace nada. */
  liberar(nonce: string): void {
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 64) throw new Error("nonce invalido");
    this.ctx.storage.sql.exec("DELETE FROM reservas WHERE nonce = ?", nonce);
  }
}
