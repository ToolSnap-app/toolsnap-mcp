/**
 * POST /x402/tools/<name> — the HTTP door onto the MCP payment gate, so the
 * x402 indexes (which only probe HTTP routes) see a real `402` with a
 * `PAYMENT-REQUIRED` header. See discovery.ts for the why.
 *
 * Without a payment header: answer the x402 v2 challenge (HTTP transport:
 * base64 PaymentRequired in PAYMENT-REQUIRED, same object as the body).
 * With `PAYMENT-SIGNATURE`: re-dispatch as an MCP tools/call carrying the
 * decoded payload in _meta["x402/payment"] and translate the answer back.
 * Every money decision (verify, first-call-free, settle) stays in
 * src/mcp/server.ts; nothing here charges, settles or skips a check.
 */

import type { Env } from "../index.js";
import { dispatch } from "../mcp/server.js";
import { requiresPayment, getToolPrice, type ToolPrice } from "./middleware.js";
import { HTTP_TOOL_PREFIX, buildHttpPaymentRequired } from "./discovery.js";


function b64encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decodeJson(value: string): unknown {
  const bin = atob(value.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Headers browser-based x402 clients need to read on the HTTP door. */
export const X402_EXPOSE_HEADERS = "PAYMENT-REQUIRED, PAYMENT-RESPONSE";

function jsonOut(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}


function paymentRequiredResponse(body: Record<string, unknown>): Response {
  return jsonOut(body, 402, { "PAYMENT-REQUIRED": b64encodeJson(body) });
}

/**
 * Quote for a probe with no payment: the real price when the body carries
 * enough to price it, else the tool's representative quote (dynamic pricers
 * never throw for undefined args). A payer who signs the representative quote
 * for args that cost more is rejected by verifyPayment and gets a fresh 402
 * with the right amount — nothing is charged.
 */
function quote(toolName: string, env: Env, args: Record<string, unknown>): ToolPrice {
  try {
    return getToolPrice(toolName, env, args);
  } catch {
    return getToolPrice(toolName, env);
  }
}

export async function handleX402HttpTool(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const toolName = url.pathname.slice(HTTP_TOOL_PREFIX.length);
  if (!requiresPayment(toolName)) {
    return jsonOut({ error: "not_found", hint: "Only paid tools are served here; see /.well-known/x402." }, 404);
  }

  const paymentHeader = request.headers.get("payment-signature") ?? request.headers.get("x-payment");

  if (request.method === "GET") {
    // Probes that try GET first still get the challenge (x402scan's
    // method-aware fallback); the bazaar declaration says POST.
    if (paymentHeader) {
      return jsonOut({ error: "method_not_allowed", hint: "Send paid calls as POST with a JSON body." }, 405, { Allow: "POST" });
    }
    const p = getToolPrice(toolName, env);
    return paymentRequiredResponse(buildHttpPaymentRequired(toolName, p.payPerCallStr, env.X402_PAY_TO_ADDRESS));
  }
  if (request.method !== "POST") {
    return jsonOut({ error: "method_not_allowed" }, 405, { Allow: "GET, POST" });
  }

  // Unauthenticated probes must reach the 402 before any body validation, so
  // a missing or malformed body only matters once a payment is attached.
  let args: Record<string, unknown> = {};
  let bodyOk = true;
  try {
    const text = await request.text();
    if (text.trim()) {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        bodyOk = false;
      }
    }
  } catch {
    bodyOk = false;
  }

  if (!paymentHeader) {
    const p = quote(toolName, env, args);
    return paymentRequiredResponse(buildHttpPaymentRequired(toolName, p.payPerCallStr, env.X402_PAY_TO_ADDRESS));
  }
  if (!bodyOk) {
    return jsonOut({ error: "invalid_body", hint: "Body must be a JSON object with the tool arguments." }, 400);
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = b64decodeJson(paymentHeader);
  } catch {
    const p = quote(toolName, env, args);
    return paymentRequiredResponse(
      buildHttpPaymentRequired(toolName, p.payPerCallStr, env.X402_PAY_TO_ADDRESS, "PAYMENT-SIGNATURE is not base64-encoded JSON")
    );
  }

  // Same gate as MCP: no admin flag, no API key, no OAuth identity, no
  // prepaid proof — only the x402 payload, so it lands on the whitelist or
  // pay-per-call path exactly as an MCP client with a wallet would.
  const rpc = await dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args, _meta: { "x402/payment": paymentPayload } },
    },
    env,
    false,
    ctx,
    request.headers.get("user-agent") ?? "",
    "",
    false,
    null,
    null,
    request.headers.get("cf-connecting-ip") ?? "unknown"
  );

  const r = rpc as {
    error?: { code: number; message: string; data?: { error?: string; accepts?: Array<{ amount?: string }> } };
    result?: { content?: Array<{ text?: string }>; isError?: boolean; _meta?: Record<string, unknown> };
  } | null;

  if (r?.error?.code === 402) {
    // Re-issue the challenge in HTTP form, at the amount the gate asked for.
    const amountMicro = r.error.data?.accepts?.[0]?.amount;
    const priceUSDC = amountMicro ? (Number(amountMicro) / 1_000_000).toString() : quote(toolName, env, args).payPerCallStr;
    return paymentRequiredResponse(
      buildHttpPaymentRequired(toolName, priceUSDC, env.X402_PAY_TO_ADDRESS, r.error.data?.error ?? r.error.message)
    );
  }
  if (!r?.result || r.error) {
    return jsonOut({ error: r?.error?.message ?? "internal_error" }, 500);
  }

  const text = r.result.content?.[0]?.text ?? "";
  if (r.result.isError) {
    // Pricing or tool failure — the MCP gate never settles on these.
    return jsonOut({ error: text }, 422);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { result: text };
  }
  const settlement = r.result._meta?.["x402/payment-response"];
  return jsonOut(data, 200, settlement ? { "PAYMENT-RESPONSE": b64encodeJson(settlement) } : {});
}

