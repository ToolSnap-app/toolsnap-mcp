# ToolSnap MCP

> One connection, superpowers for your agent: deterministic microtools. Pay per call with USDC on Base — no account needed — or buy fiat credits with a card if you'd rather not touch crypto.

[![toolsnap-mcp MCP server](https://glama.ai/mcp/servers/ToolSnap-app/toolsnap-mcp/badges/score.svg)](https://glama.ai/mcp/servers/ToolSnap-app/toolsnap-mcp)
[![MCP](https://img.shields.io/badge/MCP-streamable--http-6366f1)](https://mcp.toolsnap.app/.well-known/mcp.json)
[![x402](https://img.shields.io/badge/payment-x402%20v2-orange)](https://x402.org)
[![Base](https://img.shields.io/badge/network-Base%20mainnet-0052FF)](https://base.org)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F48120)](https://workers.cloudflare.com)
[![smithery badge](https://smithery.ai/badge/icosaedro/toolsnap-mcp)](https://smithery.ai/servers/icosaedro/toolsnap-mcp)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/toolsnap-app/toolsnap-mcp)

**Live endpoint:** `https://mcp.toolsnap.app/mcp`  
**Server card:** [/.well-known/mcp.json](https://mcp.toolsnap.app/.well-known/mcp.json)  
**Pricing:** [/.well-known/pricing.json](https://mcp.toolsnap.app/.well-known/pricing.json)  
**Docs:** [mcp.toolsnap.app/docs](https://mcp.toolsnap.app/docs)

---

## Why

ToolSnap is built around three ideas:

**1. Deterministic — no LLM in the loop.** Most agent stacks now "clean" web pages by paying a second model to summarize them. ToolSnap's extraction is pure parsing: exact quotes, stable output, zero added inference cost, reproducible runs. What you extract is what the page said.

**2. Context-efficient by design.** The biggest cost for AI agents isn't generation — it's context. Loading a raw webpage can burn 50,000+ tokens on HTML boilerplate; connecting a fat MCP server can burn as many in tool definitions. ToolSnap moves the work server-side *and* keeps discovery compact: `tools/list` shows a small curated core, and the full catalog of 47 microtools (web, PDFs, CSV/JSON, sitemaps, RSS, images, media generation…) sits one free `tool_catalog()` call away, executed via `use_tool`.

**Benchmark (11 real pages, June 2026):**

| | Raw HTML | Extracted | Saving |
|---|---|---|---|
| Median tokens | 53,820 | 2,001 | **98.1%** |
| Cost @ Sonnet ($3/M) | $0.162 | $0.006 | **$0.156/call** |
| Break-even page size | — | — | 26 KB |

`fetch_extract` is free — this saving costs nothing.

**3. No account required (crypto path).** Free tools work the second you connect. Paid tools settle per call with USDC on Base via [x402](https://x402.org) — an agent with a wallet can pay cold: no signup, no subscription, no key management. Rather not touch crypto? [Buy fiat credits with a card](https://mcp.toolsnap.app/checkout) and get an API key instead — same discounted per-call price, no wallet needed.

---

## Connect

### Any agent, one line

Hand your agent this prompt and it can do the rest on its own:

```
Set up https://mcp.toolsnap.app/SKILL.md — connect the MCP server it describes and save the skill for future sessions.
```

[`SKILL.md`](https://mcp.toolsnap.app/SKILL.md) is a self-contained skill file (connect
config, tool discovery, cost guardrails), generated live from the tool registry so it is
never stale.

### Claude Desktop

```json
{
  "mcpServers": {
    "toolsnap": {
      "url": "https://mcp.toolsnap.app/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Free tools work immediately with the URL connection above. **Paid tools need an
x402 payment client** — a wallet alone is not enough, because most MCP clients
can't satisfy a `402 Payment Required` on their own. Use the pay-proxy below (re-download it if your copy predates the 2026-10 spec-shaped 402, see [Payment](#payment-x402)).

### Claude Code

```bash
claude mcp add --transport http toolsnap https://mcp.toolsnap.app/mcp
```

Or install the [Claude Code plugin](https://github.com/ToolSnap-app/toolsnap-claude-plugin)
(MCP connection + the `toolsnap` skill, bundled):

```
/plugin marketplace add ToolSnap-app/toolsnap-claude-plugin
/plugin install toolsnap
```

### Paid tools — connect through the pay-proxy

`scripts/pay-proxy.mjs` is a local stdio MCP server that wraps the remote
endpoint, reads your wallet, and signs + retries automatically when the server
asks for payment. The private key never leaves your host; only signatures are sent.

```json
{
  "mcpServers": {
    "toolsnap": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/toolsnap-mcp/scripts/pay-proxy.mjs"]
    }
  }
}
```

No wallet yet? Call the `wallet_setup` tool — it generates a wallet you control,
helps your human fund it with USDC on Base, and wires this proxy. Key resolution
order: `TOOLSNAP_WALLET_KEY` → `~/.toolsnap/wallet.key` → macOS Keychain
(`toolsnap-agent-wallet/default`).

Useful env: `TOOLSNAP_MAX_PRICE_USDC` (per-call spend cap, default `0.10`),
`TOOLSNAP_PREPAID=1` + `TOOLSNAP_AUTO_DEPOSIT_USDC` (use the cheaper prepaid balance).

### Paid tools — no wallet, pay with a card

Buy credits at [mcp.toolsnap.app/checkout](https://mcp.toolsnap.app/checkout) (handled by
Polar, our Merchant of Record). You'll get an API key in a one-time pop-up —
connect with it directly, no proxy needed:

```json
{
  "mcpServers": {
    "toolsnap": {
      "url": "https://mcp.toolsnap.app/mcp",
      "headers": { "Authorization": "Bearer sk_live_..." }
    }
  }
}
```

Clients that can't send custom headers (some claude.ai connectors) can embed
the key in the URL instead: `https://mcp.toolsnap.app/mcp/sk_live_...` (the
key may then appear in that client's request logs — prefer the header when
your client supports it).

### Direct MCP call

```bash
curl -X POST https://mcp.toolsnap.app/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Tools

47 tools total. `tools/list` shows a curated core of 17; discover everything else with the free `tool_catalog` tool and run it with `use_tool(name, args)`.

### Paid (x402)

| Tool | Description | Price |
|---|---|---|
| `screenshot_url` | Capture a page → public image URL. | $0.04 USDC |
| `fetch_rendered` | Render a JS page (SPA) in a headless browser → clean text. | $0.04 USDC |
| `keyword_research` | Google Ads volume/CPC/competition via DataForSEO. | $0.04 USDC |
| `remove_background` | Remove an image's background → transparent PNG URL. | $0.03 USDC |
| `image_generate` | Text-to-image via fal.ai FLUX. | from $0.02 USDC |
| `image_upscale` | 2x/4x super-resolution via fal.ai ESRGAN. | from $0.02 USDC |
| `audio_transcribe` | Speech-to-text via fal.ai Wizper. | from $0.02 USDC |
| `text_to_speech` | Text-to-speech via fal.ai Kokoro. | from $0.02 USDC |
| `video_generate` | Async text/image-to-video via fal.ai. | from $0.08 USDC |
| `csv_query_xl` / `json_query_xl` | Query URL-hosted CSV (5–100 MB) / JSON (5–25 MB). | $0.02 USDC |

No first-call-free: these tools have real per-call cost, so every call settles from the start. Media tools are priced per call from your own args (the table shows the floor). Pay-per-call is USDC on Base using [x402 v2](https://x402.org) (EIP-3009 `transferWithAuthorization`); prepaid (deposit once, debit off-chain, crypto or [card](https://mcp.toolsnap.app/checkout)) is cheaper per call.

### Free (always)

Flagship: `fetch_extract` (URL → clean text, median 98.1% fewer tokens than raw HTML) and `fetch_html` (URL → clean structured HTML). Plus a wide utility catalog:

| Tool | Description |
|---|---|
| `pricing` | Machine-readable pricing menu. Call this first. |
| `tool_catalog` | Discover the full tool catalog (families → detail). |
| `use_tool` | Execute any tool not in your tools/list. |
| `memory_snippet` | Get the ToolSnap habit block for your harness's persistent memory. |
| `task_recipes` | Ready-to-run multi-tool workflows for whole tasks. |
| `uuid_generate` | 1–100 random UUID v4 values |
| `hash_text` | SHA-256 / SHA-1 / SHA-512 (hex) |
| `base64_encode` / `base64_decode` | Base64 encode/decode |
| `url_encode` / `url_decode` | Percent-encode/decode |
| `json_format` | Parse + pretty-print or minify JSON |
| `timestamp_convert` | Unix ↔ ISO 8601 (auto-detects direction) |
| `text_stats` | Chars, words, lines, sentences |

Call `tool_catalog()` for the complete, current list with schemas and prices.

---

## Payment (x402)

When an agent calls a paid tool (e.g. `screenshot_url`) without payment, the server returns a tool result in the [x402 v2 MCP transport](https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md) shape: `isError: true`, the payment requirements in `structuredContent`, and the same object JSON-encoded in `content[0].text` (a second text block carries the next steps):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "structuredContent": {
      "x402Version": 2,
      "error": "Payment required to use this tool",
      "resource": { "url": "https://mcp.toolsnap.app/mcp#screenshot_url", "serviceName": "ToolSnap" },
      "accepts": [{
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "40000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "payTo": "0x…",
        "maxTimeoutSeconds": 300
      }],
      "extensions": { "bazaar": { "info": { "input": { "type": "mcp" } } } }
    },
    "content": [{ "type": "text", "text": "<the same JSON>" }, { "type": "text", "text": "Payment required: …" }]
  }
}
```

Until 2026-10 this was a JSON-RPC error (`error.code: 402`, `error.data`). **If you downloaded `scripts/pay-proxy.mjs` before then, download it again**: older copies only recognise the old shape and will not pay on their own. (The prepaid-deposit challenge, `account_deposit`, still answers with the JSON-RPC `402` error.)

An x402-enabled client reads `accepts[0]`, signs an EIP-3009 `TransferWithAuthorization`, and retries with `_meta["x402/payment"]` set. See [x402 spec](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md).

---

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars  # fill in wallet secrets
npm run dev
# Worker at http://localhost:8787
```

## Type-check

```bash
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

---

## Stack

- **Runtime:** Cloudflare Workers (edge, 0 ms cold start)
- **Protocol:** MCP streamable-http (JSON-RPC 2.0)
- **Payment:** x402 v2 · EIP-3009 on Base mainnet · USDC
- **Verification:** off-chain EIP-712 signature recovery (viem)
- **Settlement:** on-chain `transferWithAuthorization` via relayer wallet
- **Anti-replay:** Cloudflare KV nonce store (7-day TTL)
- **First-call-free:** mechanism exists in code (KV key `first_free:{address}`) for future flat-rate tools; all current paid tools have real COGS and are excluded, so every call settles

---

## Contributing

PRs welcome for **new free tools** in `src/tools/`. Follow the pattern in [`src/tools/text-stats.ts`](src/tools/text-stats.ts) and add the tool to [`src/tools/index.ts`](src/tools/index.ts).

For paid tools or changes to the x402 payment logic, open an issue first.

**Do not commit wallet private keys, `.dev.vars`, or any secrets.**

---

[![toolsnap-mcp MCP server](https://glama.ai/mcp/servers/ToolSnap-app/toolsnap-mcp/badges/card.svg)](https://glama.ai/mcp/servers/ToolSnap-app/toolsnap-mcp)

---

## License

MIT
