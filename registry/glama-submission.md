# Glama.ai MCP listing — reference copy
# Live listing: https://glama.ai/mcp/servers/ToolSnap-app/toolsnap-mcp (claimed; edit at /admin)
# Glama regenerates its summary from README.md + glama.json; paste the texts below
# into /admin only if the generated summary drifts from reality.
# Figures verified live on 2026-10-21 (tool_catalog + pricing).

**Server name:** ToolSnap MCP
**Endpoint:** https://mcp.toolsnap.app/mcp
**Transport:** streamable-http
**Docs:** https://mcp.toolsnap.app/docs
**Server card:** https://mcp.toolsnap.app/.well-known/mcp.json

**Short description (≤160 chars):**
Deterministic microtools for AI agents: 47 tools, 36 free. Free fetch_extract cuts page tokens 98%. Paid tools from $0.02 USDC on Base (x402) or card.

**Full description:**
Context-efficient, deterministic MCP server for AI agents — no LLM in the
extraction loop. tools/list shows a curated core of 17; the full catalog of 47
sits one free tool_catalog call away and runs via use_tool.

36 tools are free, including the flagships fetch_extract (URL → clean text,
median 98.1% fewer tokens than raw HTML: 53,820 → 2,001 on 11 real pages) and
fetch_html, plus html_to_markdown, fetch_metadata, pdf_text_extract, csv_query,
json_query, sitemap_parse, rss_parse, link checking and general utilities.

11 tools are paid because they carry real per-call cost (no first-call-free):
screenshot_url, fetch_rendered and keyword_research ($0.04), remove_background
($0.03), fal.ai media tools image_generate, image_upscale, audio_transcribe,
text_to_speech (from $0.02) and video_generate (from $0.08), and the large-file
tiers csv_query_xl / json_query_xl ($0.02). Pay per call with USDC on Base via
x402 (no account), prepay a balance (min $0.50, ~33-38% cheaper per call, no
per-call gas), or buy fiat credits with a card at https://mcp.toolsnap.app/checkout.

**Categories:** Developer Tools, Web Scraping, Paid
**Tags:** mcp, x402, usdc, base, fetch, token-reduction, cloudflare-workers
**Author/org:** ToolSnap (ToolSnap-app)
**GitHub:** https://github.com/ToolSnap-app/toolsnap-mcp
