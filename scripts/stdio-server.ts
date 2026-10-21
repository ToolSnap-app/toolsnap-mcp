/**
 * Native stdio MCP server for container inspectors (Glama, Smithery sandbox).
 *
 * Those inspectors run `mcp-proxy -- npm start` and talk newline-delimited
 * JSON-RPC over stdin/stdout, and they forbid pointing at a remote URL. The
 * production server is a Cloudflare Worker, so this script runs the SAME MCP
 * dispatcher the Worker uses (src/mcp/server.ts) in plain Node, with in-memory
 * stand-ins for the KV / D1 / R2 bindings. No workerd, no wrangler, no network
 * listener, no curl: it is ready as soon as Node has loaded the modules, so
 * `initialize` and `tools/list` answer in about a second.
 *
 * Free tools work fully. Paid tools answer with the same structured payment
 * error a real client would get, which is the expected behaviour (no funds,
 * mock secrets). Nothing here writes to stdout except JSON-RPC responses.
 */
import { createInterface } from "node:readline";
import { handleMcpRequest } from "../src/mcp/server.js";
import type { Env } from "../src/index.js";

// Mock secrets: no real funds or keys.
const MOCK_ADDRESS = "0x0000000000000000000000000000000000000000";
const MOCK_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

class MemoryKV {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<{ keys: unknown[]; list_complete: boolean }> {
    return { keys: [], list_complete: true };
  }
}

/** D1 stand-in: an empty database. Every statement succeeds and returns no rows. */
class EmptyStatement {
  bind(): this {
    return this;
  }
  async run(): Promise<{ success: true; meta: Record<string, number>; results: unknown[] }> {
    return { success: true, meta: { changes: 0, rows_read: 0, rows_written: 0 }, results: [] };
  }
  async first(): Promise<null> {
    return null;
  }
  async all(): Promise<{ results: unknown[]; success: true; meta: Record<string, number> }> {
    return { results: [], success: true, meta: {} };
  }
  async raw(): Promise<unknown[]> {
    return [];
  }
}
const emptyDb = {
  prepare: () => new EmptyStatement(),
  batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true, results: [], meta: {} })),
  exec: async () => ({ count: 0, duration: 0 }),
};

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  X402_NETWORK: process.env.X402_NETWORK ?? "eip155:8453",
  X402_PRICE_USDC: process.env.X402_PRICE_USDC ?? "0.02",
  X402_PREPAID_PRICE_USDC: process.env.X402_PREPAID_PRICE_USDC ?? "0.01",
  X402_MIN_DEPOSIT_USDC: process.env.X402_MIN_DEPOSIT_USDC ?? "0.50",
  BASE_RPC_URL: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  X402_PAY_TO_ADDRESS: process.env.X402_PAY_TO_ADDRESS ?? MOCK_ADDRESS,
  RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY ?? MOCK_KEY,
  R2_PUBLIC_URL: "http://localhost",
  X402_NONCES: new MemoryKV(),
  PREPAID_DB: emptyDb,
  // One local client, so the per-IP free-fetch limit never needs to bite.
  FREE_FETCH_RL: { limit: async () => ({ success: true }) },
  SCREENSHOTS_BUCKET: {
    put: async () => null,
    get: async () => null,
    delete: async () => undefined,
  },
} as unknown as Env;

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => undefined);
  },
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

// Anything a tool logs must not corrupt the JSON-RPC stream on stdout.
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Requests are handled one at a time so responses leave in request order.
let queue: Promise<void> = Promise.resolve();

rl.on("line", (line) => {
  const body = line.trim();
  if (!body) return;
  queue = queue.then(async () => {
    try {
      const { response } = await handleMcpRequest(body, env, false, ctx, "stdio-inspector", "", false, null, null, "stdio");
      if (response) process.stdout.write(response + "\n");
    } catch (err) {
      process.stderr.write(`[stdio-server] ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });
});

rl.on("close", () => {
  void queue.then(() => process.exit(0));
});
