/**
 * Fase 25.18 — importa este modulo ANTES de cargar (con `await import`) nada
 * que llegue a src/analytics/panel.ts: registra el hook que convierte los
 * ficheros del panel en modulos de texto, como hace wrangler. Un import
 * estatico de src/index.ts en el mismo fichero no vale: los imports estaticos
 * se resuelven antes de que este codigo se ejecute.
 *
 *   import "./_support/text-modules.js";
 *   const { default: worker } = await import("../src/index.js");
 */
import { register } from "node:module";

register("./text-modules-hook.mjs", import.meta.url);
