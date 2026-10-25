import type { McpTool } from "../mcp/types.js";

/**
 * use_tool (Fase 18) — universal execution for any tool not in the curated
 * core (tools/list). Discover names/schemas first via tool_catalog.
 *
 * This is a DEFINITION ONLY. The actual dispatch happens in src/mcp/server.ts
 * ("tools/call", right after validating toolName): it unwraps args.name/args
 * and re-enters the exact same account/x402/free-tool flow as a direct call,
 * so payment, first-call-free, analytics and the free path all apply
 * identically to the inner tool. run() below should never execute — it only
 * exists so use_tool satisfies the McpTool shape and fails loudly if it is
 * ever invoked through a path that bypassed the dispatcher unwrap.
 */
const HANDLED_AT_SERVER =
  "use_tool is handled by the server dispatcher before generic tool execution; it must not run directly. If you see this error, the request bypassed the tools/call unwrap logic in src/mcp/server.ts.";

export const useToolTool: McpTool = {
  name: "use_tool",
  description:
    "Free wrapper. Runs any catalog tool missing from your tools/list exactly as a direct call: args pass through unchanged and the inner tool's price, payment, result and errors apply verbatim. Its hints are the worst case over the whole catalog: not read-only because some inner tools create a render, a stored file or a ledger entry; never destructive because no catalog tool deletes or overwrites anything. Get the inner tool's name, schema and its own annotations from tool_catalog(tool='<name>') first. A missing or unknown name errors pointing to tool_catalog; it cannot call itself.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name from tool_catalog. Not 'use_tool'." },
      args: { type: "object", description: "Object matching that tool's inputSchema. Omit if none required." },
    },
    required: ["name"],
  },
  // Annotations live in src/tools/annotations.ts: the worst case over the
  // catalog (not read-only, never destructive), spelled out in the description
  // so directories do not read the static hints as contradicting the
  // pass-through semantics (Glama TDQS v0.1.5 scored Behavior 1/5 on that).
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
};
