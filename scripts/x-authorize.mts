/**
 * One-time PIN-based OAuth1.0a authorization for an X account (Fase 22.1).
 *
 * OAuth1.0a access tokens don't expire (see nota 10 §3 / vault plan D3),
 * so this only needs to run once per account (product @ToolSnapMCP,
 * personal @icosaedro_one) to mint the token/secret pair that goes into
 * X_ACCESS_TOKEN_(PRODUCT|PERSONAL) / X_ACCESS_TOKEN_SECRET_(PRODUCT|PERSONAL).
 * Since A16 the personal pair lives in toolsnap-x-personal (workers/x-personal),
 * not in toolsnap-mcp: the printed instructions say which Worker gets what.
 *
 * Run:  X_API_KEY=... X_API_SECRET=... npx tsx scripts/x-authorize.mts
 *
 * Prints an authorize URL — open it LOGGED IN AS THE ACCOUNT YOU'RE
 * AUTHORIZING (product or personal), approve the app, and paste the PIN
 * X shows back here. Prints the resulting secrets to store with
 * `wrangler secret put`.
 */
import { createInterface } from "node:readline/promises";
import { getAccessToken, getRequestToken } from "../src/x-agent/oauth1.js";

function checkForStrayWhitespace(name: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed !== raw) {
    console.warn(
      `⚠️  ${name} had leading/trailing whitespace (raw length ${raw.length}, trimmed length ${trimmed.length}) — using the trimmed value.`
    );
  }
  console.log(`${name}: length ${trimmed.length}, starts "${trimmed.slice(0, 4)}...", ends "...${trimmed.slice(-4)}"`);
  return trimmed;
}

async function main() {
  const rawKey = process.env.X_API_KEY;
  const rawSecret = process.env.X_API_SECRET;
  if (!rawKey || !rawSecret) {
    console.error("Set X_API_KEY and X_API_SECRET (the X app's consumer key/secret) before running.");
    process.exit(1);
  }
  const consumerKey = checkForStrayWhitespace("X_API_KEY", rawKey);
  const consumerSecret = checkForStrayWhitespace("X_API_SECRET", rawSecret);

  console.log("\nRequesting a request token...");
  const { oauthToken, oauthTokenSecret } = await getRequestToken(consumerKey, consumerSecret);

  const authorizeUrl = `https://api.x.com/oauth/authorize?oauth_token=${oauthToken}`;
  console.log(`\nOpen this URL LOGGED IN AS THE ACCOUNT YOU WANT TO AUTHORIZE:\n\n  ${authorizeUrl}\n`);
  console.log("Approve the app, then copy the PIN X shows you.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pin = (await rl.question("PIN: ")).trim();
  rl.close();

  console.log("\nExchanging PIN for a permanent access token...");
  const { accessToken, accessTokenSecret, screenName, userId } = await getAccessToken(
    consumerKey,
    consumerSecret,
    oauthToken,
    oauthTokenSecret,
    pin
  );

  console.log(`\nAuthorized as @${screenName} (user id ${userId}).\n`);
  // A16: each account's token goes to a DIFFERENT Worker. Product
  // (@ToolSnapMCP) -> toolsnap-mcp; personal (@icosaedro_one) ->
  // toolsnap-x-personal, never back into toolsnap-mcp.
  console.log("Store these in the block that matches the account you just authorized:\n");
  console.log("  PRODUCT (@ToolSnapMCP) -> toolsnap-mcp, from the repo root:");
  console.log(`    wrangler secret put X_ACCESS_TOKEN_PRODUCT          -> ${accessToken}`);
  console.log(`    wrangler secret put X_ACCESS_TOKEN_SECRET_PRODUCT   -> ${accessTokenSecret}`);
  console.log(`    wrangler secret put X_USER_ID_PRODUCT               -> ${userId}`);
  console.log("\n  PERSONAL (@icosaedro_one) -> toolsnap-x-personal, from the repo root:");
  console.log(`    wrangler secret put X_ACCESS_TOKEN_PERSONAL --config workers/x-personal/wrangler.jsonc         -> ${accessToken}`);
  console.log(`    wrangler secret put X_ACCESS_TOKEN_SECRET_PERSONAL --config workers/x-personal/wrangler.jsonc  -> ${accessTokenSecret}`);
  console.log(`    wrangler secret put X_USER_ID_PERSONAL --config workers/x-personal/wrangler.jsonc             -> ${userId}`);
  console.log("\nRepeat this script for the other account before deploying.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
