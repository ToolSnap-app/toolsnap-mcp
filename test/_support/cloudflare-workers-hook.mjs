// A16 — hook de carga de Node para "cloudflare:workers" (lo registra
// test/_support/cloudflare-workers.ts). Solo hace falta WorkerEntrypoint.
const STUB_URL = "cloudflare-workers-stub:///index.mjs";

const STUB_SOURCE = `
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: STUB_URL, format: "module", shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) return { format: "module", shortCircuit: true, source: STUB_SOURCE };
  return nextLoad(url, context);
}
