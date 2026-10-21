#!/usr/bin/env node
/**
 * ToolSnap pay-proxy — the x402 payment client for MCP.
 *
 * WHY THIS EXISTS
 * ---------------
 * `wallet_setup` gives the agent a wallet, but a wallet alone is NOT
 * enough to pay: standard MCP clients (Claude Desktop, Claude Code, …) do not
 * know how to satisfy an x402 `402 Payment Required` response — they cannot sign
 * an EIP-3009 authorization and retry the call. So every paid ToolSnap tool is
 * effectively unreachable from a vanilla client, even with a funded wallet.
 *
 * This proxy closes that gap. It is a local stdio MCP server that wraps the
 * remote ToolSnap HTTP endpoint and, when the server answers `402`, it signs the
 * exact payment the server asked for (using the local wallet) and transparently
 * retries. From the client's point of view, paid tools "just work".
 *
 * Point your MCP client at THIS file instead of the URL:
 *
 *   {
 *     "mcpServers": {
 *       "toolsnap": {
 *         "command": "node",
 *         "args": ["/ABSOLUTE/PATH/scripts/pay-proxy.mjs"]
 *       }
 *     }
 *   }
 *
 * The wallet key is read locally and NEVER sent to the server (only signatures
 * are). The server never sees the private key — same security contract as
 * `wallet_setup`.
 *
 * KEY SOURCES (first match wins)
 *   1. env TOOLSNAP_WALLET_KEY = 0x… (32-byte hex)
 *   2. file ~/.toolsnap/wallet.key  (created by wallet_setup file fallback)
 *   3. macOS Keychain: security find-generic-password -s toolsnap-agent-wallet -a default -w
 *      (matches the service/account wallet_setup uses via the Python `keyring` lib)
 *
 * CONFIG (env)
 *   TOOLSNAP_MCP_URL          remote endpoint     (default https://mcp.toolsnap.app/mcp)
 *   TOOLSNAP_MAX_PRICE_USDC   per-call spend cap  (default 0.10) — refuse to auto-pay above this
 *   TOOLSNAP_PREPAID          "1" → prepaid mode: attach a signed SpendAuthorization to paid
 *                             calls so the server debits your deposited balance ($0.01/call,
 *                             no per-call settlement). Falls back to pay-per-call if no balance.
 *   TOOLSNAP_AUTO_DEPOSIT_USDC  if set (e.g. "1.00"), the proxy will, in prepaid mode, sign a
 *                             one-time deposit of this amount when the balance is empty.
 *                             NON-REFUNDABLE — opt-in only, capped by this value.
 *
 * SAFETY
 *   • Only `tools/call` 402s are ever paid. Nothing else triggers a signature.
 *   • Every auto-payment is capped by TOOLSNAP_MAX_PRICE_USDC; a 402 asking for
 *     more is passed through untouched (with a note), never silently paid.
 *   • Deposits are non-refundable, so they require explicit opt-in via
 *     TOOLSNAP_AUTO_DEPOSIT_USDC and are capped by it.
 *   • The private key is never logged, printed, or transmitted.
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MCP_URL = process.env.TOOLSNAP_MCP_URL ?? "https://mcp.toolsnap.app/mcp";
const MAX_PRICE_USDC = process.env.TOOLSNAP_MAX_PRICE_USDC ?? "0.10";
const PREPAID = process.env.TOOLSNAP_PREPAID === "1";
const AUTO_DEPOSIT_USDC = process.env.TOOLSNAP_AUTO_DEPOSIT_USDC ?? "";
// Marks this proxy's traffic as our own dev/testing in server analytics (Fase 19).
// Resolution: env TOOLSNAP_INTERNAL_TOKEN → ~/.toolsnap/internal.token → unmarked.
const INTERNAL_TOKEN = resolveInternalToken();
function resolveInternalToken() {
  const env = process.env.TOOLSNAP_INTERNAL_TOKEN?.trim();
  if (env) return env;
  try {
    return readFileSync(join(homedir(), ".toolsnap", "internal.token"), "utf8").trim();
  } catch {
    return "";
  }
}

const MAX_PRICE_MICRO = usdcToMicro(MAX_PRICE_USDC);
const AUTO_DEPOSIT_MICRO = AUTO_DEPOSIT_USDC ? usdcToMicro(AUTO_DEPOSIT_USDC) : 0n;

const log = (msg) => process.stderr.write(`[toolsnap-pay] ${msg}\n`);

// ---------------------------------------------------------------------------
// Wallet key resolution (local only — never sent to the server)
// ---------------------------------------------------------------------------
function resolveKey() {
  const env = process.env.TOOLSNAP_WALLET_KEY?.trim();
  if (env) return normalizeKey(env);

  try {
    const file = join(homedir(), ".toolsnap", "wallet.key");
    const fromFile = readFileSync(file, "utf8").trim();
    if (fromFile) return normalizeKey(fromFile);
  } catch {
    /* not present — try keychain */
  }

  if (process.platform === "darwin") {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "toolsnap-agent-wallet", "-a", "default", "-w"],
        { encoding: "utf8" }
      ).trim();
      if (out) return normalizeKey(out);
    } catch {
      /* not in keychain */
    }
  }

  return null;
}

function normalizeKey(k) {
  const clean = k.startsWith("0x") ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("wallet key is not a 32-byte 0x hex string");
  }
  return clean;
}

let account = null; // lazily initialized so free tools work even without a wallet
function getAccount() {
  if (account) return account;
  const key = resolveKey();
  if (!key) {
    throw new Error(
      "No wallet found. Run the wallet_setup tool first, or set TOOLSNAP_WALLET_KEY. " +
        "Free tools still work without a wallet."
    );
  }
  account = privateKeyToAccount(key);
  return account;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function usdcToMicro(s) {
  const [whole, frac = ""] = String(s).trim().split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
}

function microToUsdc(micro) {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${whole}.${frac}`;
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function chainIdFromNetwork(network) {
  // CAIP-2 "eip155:8453" → 8453
  const m = /^eip155:(\d+)$/.exec(String(network ?? ""));
  return m ? Number(m[1]) : 8453;
}

async function postRpc(message) {
  const headers = { "Content-Type": "application/json" };
  if (INTERNAL_TOKEN) headers["X-ToolSnap-Internal"] = INTERNAL_TOKEN;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  if (res.status === 202) return null; // notification — no body
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------
/** Sign an EIP-3009 TransferWithAuthorization for `accept` → an x402 PaymentPayload. */
async function signPayment(accept) {
  const acct = getAccount();
  const now = Math.floor(Date.now() / 1000);
  const validAfter = String(now - 10);
  const validBefore = String(now + (accept.maxTimeoutSeconds ?? 300));
  const nonce = randomNonce();
  const chainId = chainIdFromNetwork(accept.network);

  const signature = await acct.signTypedData({
    domain: {
      name: accept.extra?.name ?? "USD Coin",
      version: accept.extra?.version ?? "2",
      chainId,
      verifyingContract: accept.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: acct.address,
      to: accept.payTo,
      value: BigInt(accept.amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  return {
    x402Version: 2,
    accepted: accept,
    payload: {
      signature,
      authorization: {
        from: acct.address,
        to: accept.payTo,
        value: String(accept.amount),
        validAfter,
        validBefore,
        nonce,
      },
    },
  };
}

/** Sign a prepaid SpendAuthorization (cannot move on-chain funds). */
async function signSpend(toolName) {
  const acct = getAccount();
  const now = Math.floor(Date.now() / 1000);
  const validBefore = String(now + 300);
  const nonce = randomNonce();
  const maxAmount = MAX_PRICE_MICRO.toString();

  const signature = await acct.signTypedData({
    domain: { name: "ToolSnap Prepaid", version: "1", chainId: 8453 },
    types: {
      SpendAuthorization: [
        { name: "address", type: "address" },
        { name: "tool", type: "string" },
        { name: "maxAmount", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "validBefore", type: "uint256" },
      ],
    },
    primaryType: "SpendAuthorization",
    message: {
      address: acct.address,
      tool: toolName,
      maxAmount: BigInt(maxAmount),
      nonce,
      validBefore: BigInt(validBefore),
    },
  });

  return {
    authorization: {
      address: acct.address,
      tool: toolName,
      maxAmount,
      nonce,
      validBefore,
    },
    signature,
  };
}

// ---------------------------------------------------------------------------
// 402 handling
// ---------------------------------------------------------------------------
// Two shapes reach us: the x402 v2 MCP transport for paid tools (a tool
// result with isError + structuredContent = PaymentRequired), and the
// JSON-RPC error 402 (error.data = PaymentRequired) still used for the
// prepaid deposit flow and by servers deployed before 2026-10.
function paymentRequired(resp) {
  const sc = resp?.result?.structuredContent;
  if (resp?.result?.isError && sc?.x402Version && Array.isArray(sc.accepts)) return sc;
  if (resp?.error?.code === 402) return resp.error.data ?? {};
  return null;
}
function is402(resp) {
  return paymentRequired(resp) !== null;
}
function accept402(resp) {
  return paymentRequired(resp)?.accepts?.[0] ?? null;
}
function isDeposit402(resp) {
  const url = paymentRequired(resp)?.resource?.url ?? "";
  return String(url).includes("account_deposit");
}

/** Inject a _meta key into a tools/call request (clone, don't mutate caller's object). */
function withMeta(request, key, value) {
  const params = { ...(request.params ?? {}) };
  params._meta = { ...(params._meta ?? {}), [key]: value };
  return { ...request, params };
}

/**
 * Send one client request, paying transparently if the server asks.
 */
async function handleRequest(request) {
  const isToolCall = request.method === "tools/call";
  // use_tool is a transparent dispatcher: the server binds payment to the
  // INNER tool name, so sign for that one, not for "use_tool".
  let toolName = request.params?.name;
  if (toolName === "use_tool" && typeof request.params?.arguments?.name === "string") {
    toolName = request.params.arguments.name;
  }

  // Prepaid mode: attach a fresh SpendAuthorization up-front (ignored by the
  // server for free tools). If there's no balance the server returns a deposit
  // 402, handled below.
  let outbound = request;
  if (isToolCall && PREPAID && toolName) {
    try {
      outbound = withMeta(request, "x402/prepaid-spend", await signSpend(toolName));
    } catch (err) {
      // No wallet etc. — fall through; the call may be free or will 402.
      log(`prepaid sign skipped: ${err.message}`);
    }
  }

  let resp = await postRpc(outbound);

  if (!isToolCall || !is402(resp)) return resp;

  // --- Deposit-required 402 (prepaid balance empty / opening a balance) ---
  if (isDeposit402(resp)) {
    if (!PREPAID || AUTO_DEPOSIT_MICRO === 0n) {
      // Don't auto-spend money the user didn't authorize. Surface as-is.
      return resp;
    }
    const accept = accept402(resp);
    const need = BigInt(accept?.amount ?? "0");
    if (AUTO_DEPOSIT_MICRO < need) {
      log(`auto-deposit ${microToUsdc(AUTO_DEPOSIT_MICRO)} < required min ${microToUsdc(need)} — not depositing`);
      return resp;
    }
    log(`prepaid balance empty → depositing ${microToUsdc(AUTO_DEPOSIT_MICRO)} USDC (non-refundable)`);
    const depositAccept = { ...accept, amount: AUTO_DEPOSIT_MICRO.toString() };
    const depositReq = {
      jsonrpc: "2.0",
      id: `deposit-${Date.now()}`,
      method: "tools/call",
      params: { name: "account_deposit", _meta: { "x402/payment": await signPayment(depositAccept) } },
    };
    const depositResp = await postRpc(depositReq);
    if (is402(depositResp) || depositResp?.result?.isError) {
      log(`deposit failed: ${JSON.stringify(depositResp?.error ?? depositResp?.result)}`);
      return resp;
    }
    // Retry the original (with a fresh spend auth).
    return handleRequest(request);
  }

  // --- Pay-per-call 402 ---
  const accept = accept402(resp);
  if (!accept) return resp;

  const amount = BigInt(accept.amount ?? "0");
  if (amount > MAX_PRICE_MICRO) {
    log(`402 asks ${microToUsdc(amount)} USDC > cap ${MAX_PRICE_USDC} for ${toolName} — passing 402 through`);
    // Annotate so the agent understands why it wasn't paid automatically.
    const note = `Auto-payment skipped: price ${microToUsdc(amount)} USDC exceeds TOOLSNAP_MAX_PRICE_USDC=${MAX_PRICE_USDC}. Raise the cap to allow it.`;
    if (resp.error) {
      resp.error.data = { ...resp.error.data, proxy_note: note };
    } else {
      resp.result.structuredContent = { ...resp.result.structuredContent, proxy_note: note };
      resp.result.content = [...(resp.result.content ?? []), { type: "text", text: note }];
    }
    return resp;
  }

  let payment;
  try {
    payment = await signPayment(accept);
  } catch (err) {
    // No wallet — pass the (wallet_setup-hinted) 402 straight through.
    log(`cannot pay: ${err.message}`);
    return resp;
  }

  log(`paying ${microToUsdc(amount)} USDC for ${toolName}`);
  const paidResp = await postRpc(withMeta(request, "x402/payment", payment));
  return paidResp;
}

// ---------------------------------------------------------------------------
// stdio loop
// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return; // not JSON-RPC — ignore
  }

  try {
    const resp = await handleRequest(request);
    if (resp !== null && resp !== undefined) {
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  } catch (err) {
    process.stderr.write(`[toolsnap-pay] ${err?.message ?? err}\n`);
    // Best-effort JSON-RPC error so the client isn't left hanging.
    if (request?.id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `pay-proxy error: ${err?.message ?? err}` },
        }) + "\n"
      );
    }
  }
});

log(`ready → ${MCP_URL} (cap ${MAX_PRICE_USDC} USDC/call${PREPAID ? ", prepaid" : ""})`);
