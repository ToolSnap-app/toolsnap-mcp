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
  description: "Free. Run any tool not in tools/list (see tool_catalog). Same pricing as a direct call.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Tool name (see tool_catalog)." },
      args: { type: "object", description: "Args per that tool's inputSchema." },
    },
    required: ["name"],
  },
  // Annotations live in src/tools/annotations.ts. use_tool only dispatches to
  // other catalog tools, none of which delete or overwrite anything.
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
};
