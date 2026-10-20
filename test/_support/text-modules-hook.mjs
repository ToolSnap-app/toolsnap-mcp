// Fase 25.18 — hooks de carga de Node para los modulos de texto del panel
// (wrangler.jsonc "rules": Text). Igual que wrangler, decide por el IMPORT y
// no por el fichero: cuando src/analytics/panel.ts importa panel.html /
// panel.css / panel.js / panel-lib.js, los recibe como `export default
// "<texto>"`; cualquier otro importador (un test que prueba panel-lib.js como
// modulo de verdad) los recibe como JavaScript normal. Las dos variantes
// conviven en la cache de modulos porque la de texto lleva "?text" en la URL.
// Lo registra test/_support/text-modules.ts.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PANEL_TS = /\/src\/analytics\/panel\.ts$/;
const PANEL_FILE = /^\.\/panel\/(panel|panel-lib)\.(css|html|js)$/;
const TEXT_URL = /\/src\/analytics\/panel\/[^/?]+\.(css|html|js)\?text$/;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && PANEL_TS.test(context.parentURL) && PANEL_FILE.test(specifier)) {
    const url = new URL(specifier, context.parentURL);
    url.search = "text";
    return { url: url.href, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (TEXT_URL.test(url)) {
    const text = await readFile(fileURLToPath(url.replace(/\?text$/, "")), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
  }
  return nextLoad(url, context);
}
