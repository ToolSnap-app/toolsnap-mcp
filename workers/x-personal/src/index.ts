/**
 * toolsnap-x-personal (A16, 2026-10-30) — the only Worker holding the
 * personal X account's (@icosaedro_one) OAuth1.0a tokens.
 *
 * Reachable ONLY through the named RPC entrypoint `XPersonal`, which
 * Cloudflare exposes exclusively to Workers bound to it with a service
 * binding (toolsnap-mcp's X_PERSONAL, `entrypoint: "XPersonal"`). There is no
 * route and no workers.dev URL (wrangler.jsonc), and the default fetch
 * handler answers 404 to everything regardless, so being called through the
 * binding IS the authentication: there is no token for an attacker to steal.
 *
 * Exposed verbs: publish, uploadMedia, repost. Nothing else the tokens could
 * do (read DMs, follow, delete, edit the profile) is reachable.
 *
 * publish and repost share a cap of 15 posts per UTC day, counted in the
 * PublicationLimiter Durable Object (limiter.ts); uploadMedia does not count.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { PublishParams, PublishResult, XPersonalResult, XPersonalService } from "../../../src/x-agent/client.js";
import { publish, rejectFetch, repost, uploadMedia, type XPersonalEnv } from "./ops.js";

export class XPersonal extends WorkerEntrypoint<XPersonalEnv> implements XPersonalService {
  publish(params: Omit<PublishParams, "account">): Promise<XPersonalResult<PublishResult>> {
    return publish(this.env, params);
  }

  uploadMedia(bytes: Uint8Array, mimeType: string): Promise<XPersonalResult<string>> {
    return uploadMedia(this.env, bytes, mimeType);
  }

  repost(targetTweetId: string): Promise<XPersonalResult<PublishResult>> {
    return repost(this.env, targetTweetId);
  }
}

// Durable Object classes must be exported from the main module. It is not
// reachable from outside this Worker (see limiter.ts).
export { PublicationLimiter } from "./limiter.js";

export default {
  fetch: rejectFetch,
} satisfies ExportedHandler<XPersonalEnv>;
