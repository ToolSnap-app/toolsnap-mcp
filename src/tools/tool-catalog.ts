import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { FAMILIES, NOTES } from "./catalog.js";
import { requiresPayment, getToolPrice } from "../x402/middleware.js";

const HANDLED_AT_SERVER =
  "tool_catalog is env-aware and handled by the server dispatcher (runWithEnv); it must not be run directly.";

type ToolPriceShape = "free" | { payPerCall: string; prepaid: string };

function priceFor(name: string, env: Env): ToolPriceShape {
  if (!requiresPayment(name)) return "free";
  const p = getToolPrice(name, env);
  return { payPerCall: `$${p.payPerCallStr}`, prepaid: `$${p.prepaidStr}` };
}

/** Layer 1: families overview. */
function buildFamiliesLayer(env: Env, allTools: McpTool[]): string {
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const families = Object.entries(FAMILIES).map(([id, fam]) => ({
    id,
    label: fam.label,
    one_liner: fam.oneLiner,
    tool_count: fam.tools.filter((n) => byName.has(n)).length,
  }));

  return JSON.stringify(
    {
      families,
      total_tools: allTools.length,
      how_to_run:
        "Tools listed here but not in your tools/list: call them via use_tool(name, args), or directly by name if your client allows it; if your client can refresh the tool list, refresh after this call. Call tool_catalog(family='<id>') for the full tool list + schemas of a family, or tool_catalog(tool='<name>') for a single tool's detail.",
    },
    null,
    2
  );
}

/** Shape of a single tool's detail entry (layer 2). */
function toolDetail(tool: McpTool, env: Env) {
  return {
    name: tool.name,
    price: priceFor(tool.name, env),
    description: tool.description,
    ...(NOTES[tool.name] ? { notes: NOTES[tool.name] } : {}),
    inputSchema: tool.inputSchema,
  };
}

/** Layer 2: full detail for every tool in a family. */
function buildFamilyLayer(familyId: string, env: Env, allTools: McpTool[]): string {
  const family = FAMILIES[familyId];
  if (!family) {
    return JSON.stringify(
      {
        error: `Unknown family "${familyId}". Valid families: ${Object.keys(FAMILIES).join(", ")}`,
      },
      null,
      2
    );
  }
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const tools = family.tools
    .map((n) => byName.get(n))
    .filter((t): t is McpTool => Boolean(t))
    .map((t) => toolDetail(t, env));

  return JSON.stringify(
    { family: familyId, label: family.label, one_liner: family.oneLiner, tools },
    null,
    2
  );
}

/** Single-tool detail. */
function buildToolLayer(toolName: string, env: Env, allTools: McpTool[]): string {
  const tool = allTools.find((t) => t.name === toolName);
  if (!tool) {
    return JSON.stringify(
      {
        error: `Unknown tool "${toolName}". Call tool_catalog() with no arguments to list families, or tool_catalog(family='<id>') to list tools in a family.`,
        valid_families: Object.keys(FAMILIES),
      },
      null,
      2
    );
  }
  return JSON.stringify(toolDetail(tool, env), null, 2);
}

async function runToolCatalog(args: Record<string, unknown>, env: Env): Promise<string> {
  // Import lazily to avoid a circular import at module-load time
  // (index.ts imports this tool; this tool needs the full tool list).
  const { tools } = await import("./index.js");

  const family = typeof args.family === "string" ? args.family.trim() : "";
  const toolName = typeof args.tool === "string" ? args.tool.trim() : "";

  if (toolName) return buildToolLayer(toolName, env, tools);
  if (family) return buildFamilyLayer(family, env, tools);
  return buildFamiliesLayer(env, tools);
}

export const toolCatalogTool: McpTool = {
  name: "tool_catalog",
  description: "Free. Full catalog. No args → families. family='<id>' → tools. tool='<name>' → detail.",
  inputSchema: {
    type: "object",
    properties: {
      family: { type: "string", description: "Family id → its tools." },
      tool: { type: "string", description: "Tool name → detail." },
    },
    required: [],
  },
  run() {
    throw new Error(HANDLED_AT_SERVER);
  },
  async runWithEnv(args, env) {
    return runToolCatalog(args, env as Env);
  },
};
