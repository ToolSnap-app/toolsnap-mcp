/**
 * First-connection AX audit (Fase 18).
 *
 * Measures what a fresh MCP client actually receives on connection: the
 * curated core tools/list + the initialize instructions. No HTTP server
 * needed — imports the same functions the live dispatcher calls.
 *
 * DoD (nota 06 / plan Fase 18): 1st connection ≤ ~1,600 tokens (tools +
 * instructions), chars/4 estimate. Also runs the catalog integrity guard
 * (assertCatalogComplete) so a drifted FAMILIES/CORE_TOOLS entry fails loudly
 * instead of shipping silently.
 *
 * Budget history:
 *  - Fase 18 (2026-07-03): 1,600 — original curated-core budget.
 *  - 2026-07-15: 2,300 — deliberate raise (+~615 measured) to fund parameter
 *    descriptions on every core-tool input and minimal MCP annotations
 *    (spec-default-aware, 1-2 keys/tool). Decision: fewer malformed calls
 *    from agents beats a leaner list; one fetch_extract call repays the
 *    overhead ~80x. Descriptions are budget-conscious (3-6 words); do NOT
 *    add prose here to chase directory scores — see nota 06.2 §📐 principio 7.
 *  - 2026-07-21: 2,650 — deliberate raise (+~311 measured) to cover growth
 *    that landed without re-budgeting: PAYMENT section expanded for fal.ai
 *    media tools + dynamic per-call pricing (fase 13.1), PRIVACY section
 *    (fase 25.1 privacy comms), and consent-framed memory_snippet (PR #61).
 *    Each line earned its place in its own phase decision; trimming them to
 *    hit the old number would undo that work. Same criterion as the 2,300
 *    raise: spend tokens where they prevent bad calls or build trust, never
 *    on prose for directory scores. Script now runs in CI so the next
 *    overshoot fails a PR instead of drifting silently.
 *  - 2026-10-22: 2,900 — deliberate raise (+~260 measured) for the `title` of
 *    every core tool, advertised both top-level (MCP 2025-06-18) and as
 *    annotations.title (older clients, Glama TDQS, Anthropic Software
 *    Directory Policy 5E). Required for directory listing, not prose; the
 *    hint keys that equal the spec defaults stay omitted to keep this small.
 *  - 2026-10-24: 3,250 — deliberate raise (+~332 measured) for the five
 *    lowest-scoring core tools in Glama's TDQS of v0.1.2 (B, 3.6/5; the June
 *    A, 4.6, had longer descriptions): memory_snippet, json_query, fetch_html,
 *    html_to_markdown, pdf_text_extract. Each now states what it returns, its
 *    limits and what it does not do, and its parameters say format/limits.
 *    Spend is on accuracy (Anthropic Directory Policy §2: precise, no pushing
 *    to other tools), not marketing; the other 12 tools are untouched.
 *  - 2026-10-25: 3,900 — second round (+647 measured) for Glama's TDQS of
 *    v0.1.4 (4.1/5: the five rewritten tools went to 4.3-4.9, the untouched
 *    ones kept 3.5-3.8). Same recipe on the six lowest: rss_parse,
 *    sitemap_parse, csv_query, tool_catalog, use_tool, pricing. Glama's
 *    per-tool notes asked for the output shape, truncation semantics,
 *    sitemap-index handling, what a family is and how use_tool forwards
 *    args and errors; each description now says so. Other 11 untouched.
 *
 * Run:  npx tsx scripts/first-connection-audit.ts
 */
import { listTools, tools } from "../src/tools/index.js";
import { assertCatalogComplete } from "../src/tools/catalog.js";
import { buildServerInstructions } from "../src/mcp/server.js";
import type { Env } from "../src/index.js";

const TOKEN_BUDGET = 3_900;

/** Rough token estimate: chars / 4 (same heuristic used across the project docs). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Dummy env — only the fields buildServerInstructions/getToolPrice touch are
// needed. Cast through unknown since Env has many unrelated required bindings
// (KV/D1/R2) that are irrelevant to a pure string-building call.
const dummyEnv = {
  X402_NETWORK: "eip155:8453",
  X402_PRICE_USDC: "0.02",
  X402_PREPAID_PRICE_USDC: "0.01",
  X402_MIN_DEPOSIT_USDC: "0.50",
  BASE_RPC_URL: "https://mainnet.base.org",
  X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000dEaD",
  RELAYER_PRIVATE_KEY: "0x" + "1".repeat(64),
} as unknown as Env;

function main(): void {
  console.log("=== ToolSnap first-connection audit (Fase 18) ===\n");

  // 1. Catalog integrity guard — fails loudly on drift.
  assertCatalogComplete(tools.map((t) => t.name));
  console.log(`Catalog integrity: OK (${tools.length} registered tools, all in ≥1 family)\n`);

  // 2. Curated core tools/list.
  const coreTools = listTools("core");
  const toolsJson = JSON.stringify({ tools: coreTools });
  const toolsTokens = estimateTokens(toolsJson);

  console.log(`Core tools/list: ${coreTools.length} tools`);
  console.log("Per-tool breakdown (name → estimated tokens):");
  let sumPerTool = 0;
  for (const t of coreTools) {
    const single = JSON.stringify(t);
    const tk = estimateTokens(single);
    sumPerTool += tk;
    console.log(`  ${t.name.padEnd(22)} ${String(tk).padStart(5)} tok  (${single.length} chars)`);
  }
  console.log(`  ${"(sum of per-tool)".padEnd(22)} ${String(sumPerTool).padStart(5)} tok`);
  console.log(`tools/list payload total: ${toolsTokens} tokens (${toolsJson.length} chars)\n`);

  // 3. Instructions.
  const instructions = buildServerInstructions(dummyEnv);
  const instructionsTokens = estimateTokens(instructions);
  console.log(`instructions: ${instructionsTokens} tokens (${instructions.length} chars)\n`);

  // 4. Total + verdict.
  const total = toolsTokens + instructionsTokens;
  console.log("=== TOTAL ===");
  console.log(`tools/list:   ${toolsTokens} tokens`);
  console.log(`instructions: ${instructionsTokens} tokens`);
  console.log(`TOTAL:        ${total} tokens (budget: ${TOKEN_BUDGET})`);

  if (total > TOKEN_BUDGET) {
    console.error(
      `\nFAIL: first-connection payload (${total} tok) exceeds budget (${TOKEN_BUDGET} tok).`
    );
    process.exit(1);
  }

  console.log(`\nPASS: first-connection payload is within budget (${total} <= ${TOKEN_BUDGET}).`);
}

main();
