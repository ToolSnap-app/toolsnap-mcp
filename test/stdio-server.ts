/**
 * Glama/Smithery inspect the server with `mcp-proxy -- pnpm run start`, i.e.
 * newline-delimited JSON-RPC over stdio. This spawns the real start script and
 * checks that initialize and tools/list answer, in order, within a few seconds.
 * A regression back to wrangler dev (or anything that needs a listening port)
 * fails here instead of in Glama's container.
 *
 * Run:  npx tsx test/stdio-server.ts
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 20_000;

const child = spawn("npx", ["tsx", "scripts/stdio-server.ts"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
const replies: Record<string, any> = {};
const order: number[] = [];

const timer = setTimeout(() => fail(`no reply within ${TIMEOUT_MS} ms`), TIMEOUT_MS);

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  child.kill();
  process.exit(1);
}

lines.on("line", (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    fail(`non-JSON line on stdout: ${line.slice(0, 80)}`);
  }
  replies[msg.id] = msg;
  order.push(msg.id);
  if (order.length === 3) finish();
});

child.stdin.write(
  [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hash_text", arguments: { text: "abc", algorithm: "sha256" } } },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n") + "\n"
);

function finish(): void {
  clearTimeout(timer);
  if (order.join() !== "1,2,3") fail(`replies out of order: ${order.join()}`);
  if (replies[1].result?.serverInfo?.name !== "toolsnap-mcp") fail("initialize: wrong serverInfo");
  const list = replies[2].result?.tools;
  if (!Array.isArray(list) || list.length === 0) fail("tools/list: empty");
  if (list.some((t: any) => !t.title || t.annotations?.destructiveHint === true)) fail("tools/list: missing title or destructive tool");
  const hash = replies[3].result?.content?.[0]?.text;
  if (hash !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") fail(`hash_text: unexpected ${hash}`);
  console.log(`ok: stdio server answered initialize, tools/list (${list.length} tools) and tools/call`);
  child.stdin.end();
}

child.on("exit", (code) => process.exit(code && code !== 143 ? code : 0));
