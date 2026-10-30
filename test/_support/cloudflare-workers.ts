/**
 * A16 — importa este modulo ANTES de cargar (con `await import`) un Worker que
 * importe "cloudflare:workers" (workers/x-personal/src/index.ts): Node no
 * conoce ese especificador y el hook lo resuelve a un sustituto minimo de
 * WorkerEntrypoint y DurableObject que guardan ctx y env, como hace el runtime.
 *
 *   import "./_support/cloudflare-workers.js";
 *   const mod = await import("../workers/x-personal/src/index.js");
 */
import { register } from "node:module";

register("./cloudflare-workers-hook.mjs", import.meta.url);
