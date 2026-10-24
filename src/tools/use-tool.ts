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
    "Free wrapper. Runs any catalog tool missing from your tools/list exactly as a direct call: args pass through unchanged and the inner tool's price, payment, read-only profile, result and errors apply verbatim. A missing or unknown name errors pointing to tool_catalog; it cannot call itself. Get names and schemas from tool_catalog first.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name from tool_catalog. Not 'use_tool'." },
      args: { type: "object", description: "Object matching that tool's inputSchema. Omit if none required." },
    },
    required: ["name"],
  },
  // Annotations live in src/tools/annotations.ts. use_tool only dispatches to
  // other catalog tools, none of which delete or overwrite anything.
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
};
