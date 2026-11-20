/**
 * SSRF hardening shared by every tool that fetches a caller-supplied URL.
 *
 * Workers can't do DNS lookups before fetch(), so this can't stop DNS
 * rebinding — Cloudflare's edge itself doesn't route to private ranges,
 * which is the real backstop. This is defense in depth: it rejects the
 * obvious cases (literal loopback/private IPs, internal hostnames) cheaply,
 * and re-checks every redirect hop so a public URL can't 302 its way into
 * one of those ranges.
 */

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".internal", ".local"];
const MAX_REDIRECTS = 5;

/**
 * Auth headers a caller may ask us to forward to ITS OWN target URL (Fase 29).
 * Stateless pass-through: never logged, never persisted. Case-insensitive keys.
 */
const FORWARDABLE_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);
const MAX_FORWARD_HEADER_BYTES = 8_192;

/**
 * Validates the optional `headers` tool argument: only allowlisted keys,
 * string values, bounded total size. Throws a caller-facing Error on any
 * violation so a typo'd key fails loudly instead of being silently dropped.
 */
export function parseForwardHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("`headers` must be an object of header name -> string value.");
  }

  const allowedList = [...FORWARDABLE_HEADERS].join(", ");
  const result: Record<string, string> = {};
  let totalBytes = 0;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (!FORWARDABLE_HEADERS.has(lower)) {
      throw new Error(`\`headers\` key "${key}" is not allowed. Allowed keys: ${allowedList}.`);
    }
    if (typeof value !== "string") {
      throw new Error(`\`headers\` value for "${key}" must be a string.`);
    }
    totalBytes += new TextEncoder().encode(value).length;
    if (totalBytes > MAX_FORWARD_HEADER_BYTES) {
      throw new Error(`\`headers\` total size exceeds ${MAX_FORWARD_HEADER_BYTES} bytes.`);
    }
    result[lower] = value;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Shared JSON Schema property for the optional `headers` argument (Fase 29).
 * Kept to one short line on purpose: this is inlined into every core URL
 * tool's schema, and the curated tools/list has a strict token budget (see
 * catalog.ts) — full semantics (allowlist, same-origin, no-store) live in
 * tool_catalog's NOTES, one free call away.
 */
export const HEADERS_SCHEMA_PROPERTY = {
  type: "object" as const,
  description: "Headers to forward (Authorization, Cookie…).",
};

function isIPv4(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/** Value of the address's first 16-bit group (hextet), or null if unparseable. */
function firstHextet(host: string): number | null {
  const first = host.split(":")[0];
  if (first === "") return 0; // address starts with "::" — leading group is all-zero
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return parseInt(first, 16);
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified

  const first = firstHextet(h);
  if (first !== null) {
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
    if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique local
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96). The URL parser normalizes these to
  // "::ffff:XXXX:YYYY" (two hex groups encoding the 4 IPv4 bytes) rather than
  // keeping a dotted-decimal suffix, so decode that form and check the
  // embedded address.
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const g1 = parseInt(mapped[1], 16);
    const g2 = parseInt(mapped[2], 16);
    const ipv4 = `${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  return false;
}

/**
 * Parses and validates a caller-supplied URL: must be http(s), and must not
 * resolve to a loopback/private/link-local address or an internal hostname.
 * Throws a caller-facing Error with a clear reason on rejection.
 */
/**
 * Fase 25.12 — the caller-facing message for a non-2xx response from the
 * destination, shared by every tool that fetches a URL.
 *
 * HTTP 530 is what a Worker's fetch() returns when the hostname does not
 * resolve (Cloudflare error 1016). The bare "HTTP 530" told the caller nothing:
 * in the 10 days before 2026-09-30 agents hit it 220 times, retrying and
 * moving on to the next tool with the same dead domain. Say what it means.
 *
 * The "Fetch failed: HTTP <status>" prefix is load-bearing: the alert
 * classifier anchors on it to file these as `upstream` (error-classification.ts).
 */
export function httpStatusError(response: { status: number; statusText: string }): Error {
  const base = `Fetch failed: HTTP ${response.status} ${response.statusText}`;
  if (response.status === 530) {
    return new Error(
      `${base.trimEnd()} (the hostname could not be resolved or its origin is unreachable: the domain most likely does not exist. Check the URL; retrying or using another tool on the same URL will fail the same way.)`
    );
  }
  return new Error(base);
}

/**
 * Fase 25.6 — the caller-facing message for a `url` ARGUMENT that isn't an
 * http(s) string, shared by every tool that pre-checks its argument before
 * fetching (fetch_extract, fetch_html, screenshot_url, extract_structured).
 *
 * Fase 25.4 added a local-path explanation to assertPublicHttpUrl, but these
 * four tools reject earlier, on their own, and so kept the bare message: a
 * real caller hit it 6 times on 2026-07-26 and never got the explanation.
 * One message, one place, so they can't drift again.
 *
 * Fase 25.22 — they had drifted anyway: eight more tools (fetch_metadata,
 * page_links, page_assets, rss_parse, sitemap_parse, pdf_text_extract,
 * html_table_extract, html_to_markdown) still threw the bare "must start with
 * http://" and, in five of them, a non-string `url` was a TypeError that
 * classified as OUR error. Every tool that takes a `url` argument now throws
 * this one.
 */
export function httpUrlArgError(raw: unknown, field = "url"): Error {
  const base = `\`${field}\` must be a string starting with http:// or https://`;
  if (typeof raw !== "string" || raw.trim() === "") {
    return new Error(`${base}. Received ${raw === undefined ? "nothing" : typeof raw}.`);
  }
  const value = raw.trim();
  if (/^(~|\.{1,2}\/|\/(?!\/)|[a-zA-Z]:[\\/])/.test(value)) {
    return new Error(
      `${base}. Local file paths are not supported: ToolSnap fetches server-side, so it cannot read your filesystem. Pass a public URL, or upload the file first via POST /upload and query the URL it returns.`
    );
  }
  if (/^[a-zA-Z][\w+.-]*:/.test(value)) {
    return new Error(`${base}. Got the "${value.split(":")[0]}:" scheme, which is not supported.`);
  }
  // Bare host or search term — the most likely fix is just adding the scheme.
  return new Error(`${base}. Try "https://${value}".`);
}

export function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Fase 25.4 — the single most repeated real-caller mistake in the
    // 2026-07-25 analytics review (7 occurrences across two agents): passing a
    // local filesystem path. The fetch runs on ToolSnap's edge, not on the
    // caller's machine, so the path can never resolve — say so instead of
    // leaving the agent to retry the same path.
    // Windows drive paths ("C:\tmp\x.csv") parse as a URL with scheme "c:" and
    // never reach here — they fall through to the protocol check below.
    if (/^(~|\.{1,2}\/|\/(?!\/))/.test(raw.trim())) {
      throw new Error(
        "`url` must be a valid absolute URL (http:// or https://). Local file paths are not supported: ToolSnap fetches server-side, so it cannot read your filesystem. Pass a public URL, or send the file content inline via the tool's raw-content argument (`csv`/`json`/`html`/`data`)."
      );
    }
    throw new Error("`url` must be a valid absolute URL (http:// or https://).");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("`url` must start with http:// or https://");
  }

  // URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]") — strip them.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || BLOCKED_HOSTNAME_SUFFIXES.some((suf) => hostname.endsWith(suf))) {
    throw new Error(`URL host "${parsed.hostname}" is not allowed (local/internal hostname).`);
  }
  if (isIPv4(hostname) && isPrivateIPv4(hostname)) {
    throw new Error(`URL host "${parsed.hostname}" is not allowed (private/reserved IP address).`);
  }
  if (hostname.includes(":") && isPrivateIPv6(hostname)) {
    throw new Error(`URL host "${parsed.hostname}" is not allowed (private/reserved IP address).`);
  }

  return parsed;
}

export interface FilesEnv {
  SCREENSHOTS_BUCKET: R2Bucket;
}

const OWN_FILES_HOST = "mcp.toolsnap.app";
const FILES_PREFIX = "/files/";

/**
 * If `rawUrl` points at one of our own /files/<key> objects (e.g. one minted
 * by POST /upload or a paid tool's own output), read it straight from the R2
 * binding instead of fetching. A Cloudflare Worker cannot fetch() its own
 * zone (same-zone subrequest loopback is blocked), so a plain fetch() to our
 * own /files/ URL always fails — this is the fix, mirroring the pattern
 * src/fal/client.ts resolveSourceAsDataUri already uses for image tools.
 * Returns null for any other URL (caller should fall through to a normal
 * fetch), or a 404 Response if the key doesn't exist in R2.
 */
export async function resolveOwnFilesResponse(rawUrl: string, env: FilesEnv): Promise<Response | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== OWN_FILES_HOST || !parsed.pathname.startsWith(FILES_PREFIX)) {
    return null;
  }
  const key = decodeURIComponent(parsed.pathname.slice(FILES_PREFIX.length));
  if (!key) return null;

  const obj = await env.SCREENSHOTS_BUCKET.get(key);
  if (!obj) return new Response("File not found", { status: 404, statusText: "Not Found" });
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(obj.body, { status: 200, headers: { "Content-Type": contentType } });
}

export interface SafeFetchOptions {
  /**
   * Caller-supplied auth headers (from parseForwardHeaders) forwarded ONLY
   * while the current hop's host matches the original request's host. The
   * moment a redirect crosses to a different host, these are dropped for all
   * subsequent hops — a 302 must not be able to carry a credential to a
   * domain the caller never authorised it for.
   */
  forwardHeaders?: Record<string, string>;
  /**
   * Env (R2 binding) — when provided, a URL matching our own /files/ prefix
   * is served directly from R2 (see resolveOwnFilesResponse) instead of
   * being fetched, which would fail (same-zone loopback).
   */
  env?: FilesEnv;
}

/**
 * Drop-in replacement for fetch() on caller-supplied URLs: validates the URL
 * (and every redirect hop) against assertPublicHttpUrl before following it.
 * Redirects are followed manually — `redirect: "follow"` would let fetch
 * chase a Location header we never got to inspect.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {}
): Promise<Response> {
  if (opts.env) {
    const own = await resolveOwnFilesResponse(rawUrl, opts.env);
    if (own) return own;
  }

  let current = assertPublicHttpUrl(rawUrl);
  const originalHost = current.hostname.toLowerCase();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sameOrigin = current.hostname.toLowerCase() === originalHost;
    const headers = new Headers(init.headers);
    if (sameOrigin && opts.forwardHeaders) {
      for (const [key, value] of Object.entries(opts.forwardHeaders)) {
        headers.set(key, value);
      }
    }

    const response = await fetch(current.toString(), { ...init, headers, redirect: "manual" });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = isRedirect ? response.headers.get("location") : null;
    if (!isRedirect || !location) return response;

    if (hop === MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
    }
    response.body?.cancel().catch(() => {});
    current = assertPublicHttpUrl(new URL(location, current).toString());
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
}
