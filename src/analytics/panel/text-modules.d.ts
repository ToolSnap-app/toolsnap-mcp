// Fase 25.18 — los tres ficheros del panel entran en el bundle como texto
// (wrangler.jsonc "rules": Text). El patron "*/panel/*.js" tiene que ser
// comodin y acotado a esta carpeta: un "*.js" generico taparia la resolucion
// normal de los imports "./x.js" -> x.ts del resto del repo.
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.html" {
  const text: string;
  export default text;
}
declare module "*/panel/panel.js" {
  const text: string;
  export default text;
}
declare module "*/panel/panel-lib.js" {
  const text: string;
  export default text;
}
