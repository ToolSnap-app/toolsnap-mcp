/**
 * A16 (2026-10-30) — relayer wallet balance check.
 *
 * The relayer (RELAYER_PRIVATE_KEY) pays the gas for x402 deposits and for
 * pay-per-call settlements whenever CDP is not settling. Unai keeps its
 * balance between a floor and a cap that he alone manages (Claude never moves
 * funds or touches the key):
 *   - floor $5 of ETH: below it, settlements may start failing for lack of gas;
 *   - cap $50 of ETH + USDC: the most an attacker who reads the key can take
 *     (the wallet also holds a little USDC: it pays for Hermes' own calls).
 * This module only READS: the wallet's ETH and USDC balances and Chainlink's
 * ETH/USD feed on Base, through the public RPC in BASE_RPC_URL. The address is the
 * public RELAYER_ADDRESS var, never derived from the key.
 *
 * Entry points (deliberately not a cron, see docs/A16-radio-de-dano.md):
 *   - checkRelayerBalance(): read + page if out of range (deduped 24h);
 *     GET /reports/relayer-balance calls it through checkRelayerBalanceCached
 *     (60 s memo, so a burst on the route does not hammer the public RPC the
 *     x402 settlement also uses).
 *   - maybeCheckRelayerBalance(): the same, at most once an hour per
 *     isolate and never throwing, for ctx.waitUntil after a relayer
 *     settlement (src/mcp/server.ts).
 */
import { createPublicClient, erc20Abi, formatEther, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { sendTelegram, type TelegramEnv } from "./telegram.js";
import { USDC_ADDRESS } from "../x402/middleware.js";

export interface RelayerBalanceEnv extends TelegramEnv {
  BASE_RPC_URL: string;
  RELAYER_ADDRESS?: string;
}

/** Decided by Unai on 2026-10-30. */
export const RELAYER_FLOOR_USD = 5;
export const RELAYER_CAP_USD = 50;

/** Chainlink ETH / USD on Base mainnet (description() = "ETH / USD", 8 decimals; checked 2026-10-30). */
export const CHAINLINK_ETH_USD_BASE: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

const FEED_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;
const FEED_DECIMALS = 8;
/** ETH/USD on Base heartbeats every ~20 min; older than this is a failed read, not a price. */
export const FEED_MAX_AGE_S = 2 * 60 * 60;

export interface RelayerBalance {
  address: Address;
  wei: bigint;
  eth: string;
  ethUsd: number;
  /** USD value of the ETH (the gas). */
  usd: number;
  usdc: number;
  /** ETH + USDC in USD: what the key exposes. */
  totalUsd: number;
  status: "low" | "ok" | "above_cap";
}

/** The floor is about gas (ETH only); the cap about exposure (ETH + USDC). */
export function classifyRelayer(gasUsd: number, totalUsd: number): RelayerBalance["status"] {
  if (gasUsd < RELAYER_FLOOR_USD) return "low";
  if (totalUsd > RELAYER_CAP_USD) return "above_cap";
  return "ok";
}

export async function readRelayerBalance(env: RelayerBalanceEnv, now: number = Date.now()): Promise<RelayerBalance> {
  if (!env.RELAYER_ADDRESS) throw new Error("RELAYER_ADDRESS is not configured");
  const address = getAddress(env.RELAYER_ADDRESS.trim());
  const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });
  const [wei, round, usdcMicro] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: CHAINLINK_ETH_USD_BASE, abi: FEED_ABI, functionName: "latestRoundData" }),
    client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  const answer = round[1];
  if (answer <= 0n) throw new Error(`Chainlink ETH/USD returned a non-positive price (${answer})`);
  const ageS = Math.floor(now / 1000) - Number(round[3]);
  if (ageS > FEED_MAX_AGE_S) throw new Error(`Chainlink ETH/USD price is stale (${ageS}s old, max ${FEED_MAX_AGE_S}s)`);
  const ethUsd = Number(answer) / 10 ** FEED_DECIMALS;
  const eth = formatEther(wei);
  const usd = Number(eth) * ethUsd;
  const usdc = Number(usdcMicro) / 1e6;
  const totalUsd = usd + usdc;
  return { address, wei, eth, ethUsd, usd, usdc, totalUsd, status: classifyRelayer(usd, totalUsd) };
}

// --- alert dedupe -----------------------------------------------------------
// One page per status per 24h, marked only AFTER Telegram accepted the page
// (a failed send must not buy 24h of silence). Two marks, either one mutes:
// in memory (always written, so the isolate dedupes even if the Cache API
// silently keeps nothing) and the Cache API (per colo, no KV quota: the
// X402_NONCES KV only has 1,000 puts/day). Both are per isolate/colo, not
// global: another colo can page once more (follow-up M3 in the A16 doc).
const ALERT_TTL_S = 24 * 60 * 60;
const ALERT_CACHE_ORIGIN = "https://relayer-balance.toolsnap.internal/";
const lastAlertAt = new Map<string, number>();

function alertCache(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

function alertKey(status: string): Request {
  return new Request(`${ALERT_CACHE_ORIGIN}${status}`, { method: "GET" });
}

async function alertedRecently(status: string, now: number): Promise<boolean> {
  const last = lastAlertAt.get(status);
  if (last !== undefined && now - last < ALERT_TTL_S * 1000) return true;
  const cache = alertCache();
  if (!cache) return false;
  try {
    return (await cache.match(alertKey(status))) !== undefined;
  } catch {
    return false;
  }
}

async function markAlerted(status: string, now: number): Promise<void> {
  lastAlertAt.set(status, now);
  const cache = alertCache();
  if (!cache) return;
  try {
    await cache.put(alertKey(status), new Response("1", { headers: { "Cache-Control": `public, max-age=${ALERT_TTL_S}` } }));
  } catch {
    // the in-memory mark above still holds for this isolate
  }
}

export function relayerAlertText(b: RelayerBalance): string {
  const head =
    b.status === "low"
      ? `🟠 Relayer con poco gas: $${b.usd.toFixed(2)} en ETH (mínimo $${RELAYER_FLOOR_USD}). Si se queda sin ETH, los depósitos x402 y la liquidación sin CDP fallan.`
      : `🟠 Relayer por encima del tope: $${b.totalUsd.toFixed(2)} entre ETH y USDC (tope $${RELAYER_CAP_USD}). Es lo que perdería quien lea RELAYER_PRIVATE_KEY.`;
  return `${head}\nWallet \`${b.address}\` · ${b.eth} ETH a $${b.ethUsd.toFixed(2)} + ${b.usdc.toFixed(2)} USDC. El saldo lo gestiona Unai.`;
}

export interface RelayerCheckResult extends RelayerBalance {
  alerted: boolean;
}

/** Read the balance and page (deduped 24h) when it is outside [floor, cap]. Throws on RPC/config errors. */
export async function checkRelayerBalance(
  env: RelayerBalanceEnv,
  now: number = Date.now()
): Promise<RelayerCheckResult> {
  const b = await readRelayerBalance(env, now);
  let alerted = false;
  if (b.status !== "ok" && !(await alertedRecently(b.status, now))) {
    alerted = await sendTelegram(env, relayerAlertText(b));
    if (alerted) await markAlerted(b.status, now);
  }
  return { ...b, alerted };
}

const ROUTE_MEMO_MS = 60 * 1000;
let routeMemo: { at: number; result: RelayerCheckResult } | null = null;

/** checkRelayerBalance behind a 60 s per-isolate memo (successful reads only), for the /reports route. */
export async function checkRelayerBalanceCached(
  env: RelayerBalanceEnv,
  now: number = Date.now()
): Promise<RelayerCheckResult & { cached: boolean }> {
  if (routeMemo && now - routeMemo.at < ROUTE_MEMO_MS) return { ...routeMemo.result, cached: true };
  const result = await checkRelayerBalance(env, now);
  routeMemo = { at: now, result };
  return { ...result, cached: false };
}

const OPPORTUNISTIC_INTERVAL_MS = 60 * 60 * 1000;
let lastOpportunisticAt = 0;

/** Test hook: forget every throttle and memo. */
export function resetRelayerBalanceThrottle(): void {
  lastOpportunisticAt = 0;
  lastAlertAt.clear();
  routeMemo = null;
}

/**
 * For ctx.waitUntil right after the relayer submits a transaction: at most
 * once an hour per isolate, and never throws (a failed check must not touch
 * the payment that triggered it).
 */
export async function maybeCheckRelayerBalance(env: RelayerBalanceEnv, now: number = Date.now()): Promise<void> {
  if (now - lastOpportunisticAt < OPPORTUNISTIC_INTERVAL_MS) return;
  lastOpportunisticAt = now;
  try {
    await checkRelayerBalance(env, now);
  } catch (err) {
    console.warn("relayer balance check failed:", err instanceof Error ? err.message : String(err));
  }
}
