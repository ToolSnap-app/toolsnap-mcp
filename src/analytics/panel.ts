/**
 * HTML del panel privado /analytics (Fase 9; rediseno Fase 25.18).
 *
 * El panel vive en tres ficheros reales dentro de ./panel/ (html, css y js, mas
 * panel-lib.js con las funciones puras que prueba test/analytics-panel.ts),
 * importados como modulos de texto por las "rules" de wrangler.jsonc y
 * ensamblados aqui en una sola pagina: sin ASSETS, sin rutas nuevas, el mismo
 * GET /analytics de siempre. En Node (tests con tsx) esos imports los sirve el
 * hook test/_support/text-modules.ts.
 */
import panelHtml from "./panel/panel.html";
import panelCss from "./panel/panel.css";
import panelLib from "./panel/panel-lib.js";
import panelApp from "./panel/panel.js";

const CSS_SLOT = "/*__PANEL_CSS__*/";
const JS_SLOT = "/*__PANEL_JS__*/";

/** panel.js importa panel-lib.js para poder editarse y probarse como modulo; inline van concatenados. */
const IMPORT_LINE = /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/panel-lib\.js['"];\s*$/m;

/** Ensambla la pagina. Exportado para poder probarlo sin servir nada. */
export function assemblePanel(html: string, css: string, lib: string, app: string): string {
  if (!html.includes(CSS_SLOT) || !html.includes(JS_SLOT)) {
    throw new Error("panel.html must contain the CSS and JS slots");
  }
  if (!IMPORT_LINE.test(app)) {
    throw new Error("panel.js must import its pure functions from ./panel-lib.js");
  }
  const script = lib + "\n" + app.replace(IMPORT_LINE, "");
  // `</script>` dentro del JS cerraria el <script> inline; no deberia haber ninguno, pero nunca se confia.
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  // Reemplazo por funcion: con una cadena, String.replace interpreta "$'" y "$&"
  // del propio JS (fmtUsd devuelve '$' + ...) como patrones especiales y
  // pegaba el resto de la pagina dentro del script.
  return html.replace(CSS_SLOT, () => safeCss).replace(JS_SLOT, () => safeScript);
}

export const PANEL_HTML = assemblePanel(panelHtml, panelCss, panelLib, panelApp);
