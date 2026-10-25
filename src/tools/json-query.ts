import type { McpTool } from "../mcp/types.js";
import type { Env } from "../index.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, type FilesEnv } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 5_000_000; // 5 MB
const XL_FETCH_TIMEOUT_MS = 30_000;
const XL_MAX_JSON_BYTES = 25_000_000; // 25 MB — buffered (JSON needs the whole doc to parse), bounded by Worker RAM.

// ---------------------------------------------------------------------------
// JSONPath-lite evaluator
//
// Supported syntax:
//   $              root
//   .key           property access
//   ['key']        bracket property (handles keys with spaces/special chars)
//   [0]  [-1]      array index (negative counts from end)
//   [*]            all array elements (wildcard)
//   ..key          recursive descent — find 'key' anywhere in the tree
//   [?(@.k op v)]  filter — operators: = != > >= < <= =~
//
// Examples:
//   $.users[*].name
//   $.store.books[0].title
//   $..price
//   $.items[?(@.price < 10)].name
// ---------------------------------------------------------------------------

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [k: string]: JSONValue };

// Token types
type Token =
  | { t: "root" }
  | { t: "dot"; key: string }
  | { t: "bracket"; key: string }
  | { t: "index"; idx: number }
  | { t: "wildcard" }
  | { t: "recursive"; key: string }
  /** `expr` is kept verbatim for error messages; `filter` is the validated form. */
  | { t: "filter"; expr: string; filter: ParsedFilter };

function tokenize(path: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  // Must start with $
  if (path[0] !== "$") throw new Error("Path must start with $");
  tokens.push({ t: "root" });
  i = 1;

  while (i < path.length) {
    // Recursive descent ..
    if (path[i] === "." && path[i + 1] === ".") {
      i += 2;
      const key = readIdent(path, i);
      if (!key) throw new Error(`Expected key after '..' at position ${i}`);
      tokens.push({ t: "recursive", key });
      i += key.length;
      continue;
    }

    // Dot notation .key
    if (path[i] === ".") {
      i++;
      if (i >= path.length) break;
      const key = readIdent(path, i);
      if (!key) throw new Error(`Expected key after '.' at position ${i}`);
      tokens.push({ t: "dot", key });
      i += key.length;
      continue;
    }

    // Bracket notation [...]
    if (path[i] === "[") {
      i++;
      if (path[i] === "*" && path[i + 1] === "]") {
        tokens.push({ t: "wildcard" });
        i += 2;
        continue;
      }

      // Filter [?(@.key op value)]
      if (path[i] === "?" && path[i + 1] === "(") {
        const end = path.indexOf(")", i);
        if (end === -1) throw new Error("Unclosed filter expression");
        const expr = path.slice(i + 2, end); // skip ?( to get inner expression
        // Validated here, once, before any data is read: an unevaluable filter
        // used to fall through to `return false` per item and surface as an
        // empty result (or, with `&&`, a wrong one). See parseFilterExpr.
        tokens.push({ t: "filter", expr, filter: parseFilterExpr(expr) });
        i = end + 2; // skip ) and ]
        continue;
      }

      // Index [0] or [-1]
      if (path[i] === "-" || (path[i] >= "0" && path[i] <= "9")) {
        let numStr = "";
        if (path[i] === "-") { numStr = "-"; i++; }
        while (i < path.length && path[i] >= "0" && path[i] <= "9") {
          numStr += path[i++];
        }
        if (path[i] !== "]") throw new Error(`Expected ] at position ${i}`);
        i++;
        tokens.push({ t: "index", idx: parseInt(numStr, 10) });
        continue;
      }

      // Quoted key ['key'] or ["key"]
      if (path[i] === "'" || path[i] === '"') {
        const quote = path[i++];
        let key = "";
        while (i < path.length && path[i] !== quote) {
          if (path[i] === "\\") i++;
          key += path[i++];
        }
        i++; // closing quote
        if (path[i] !== "]") throw new Error(`Expected ] after quoted key`);
        i++;
        tokens.push({ t: "bracket", key });
        continue;
      }

      // Bare key inside brackets [key] — less common but handle it
      let key = "";
      while (i < path.length && path[i] !== "]") key += path[i++];
      i++; // ]
      tokens.push({ t: "bracket", key });
      continue;
    }

    throw new Error(`Unexpected character '${path[i]}' at position ${i}`);
  }

  return tokens;
}

function readIdent(s: string, start: number): string {
  let end = start;
  while (end < s.length && s[end] !== "." && s[end] !== "[" && s[end] !== "]") {
    end++;
  }
  return s.slice(start, end);
}

// ---------------------------------------------------------------------------
// Filter expression evaluator: @.key op value
// ---------------------------------------------------------------------------

interface ParsedFilter {
  key: string;
  op: string;
  /** Value with surrounding quotes stripped — used by every op except `=~`. */
  valStr: string;
  /** Compiled only for `=~`. */
  regex?: RegExp;
}

/** True when `&&`/`||` appear outside a quoted string — i.e. as operators, not
 *  as part of a value like `@.name = "Ben && Jerry"`. */
function hasUnquotedLogicalOp(expr: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ((c === "&" && expr[i + 1] === "&") || (c === "|" && expr[i + 1] === "|")) return true;
  }
  return false;
}

/**
 * Fase 25.5 — parses `@.key op value`, the ONLY filter shape this engine can
 * evaluate. Throws a caller-facing Error for anything else.
 *
 * Every check here is **purely syntactic and data-independent**: an expression
 * either has the shape or it doesn't, whatever JSON you feed it. That's what
 * makes it safe to run at tokenize time, before any data is touched — it can
 * never turn a well-formed filter that legitimately matches nothing into an
 * error. Those keep returning `[]` via the data-dependent `return false` paths
 * in evalFilter (missing key, no row matching a comparison), which this
 * function deliberately does NOT touch.
 *
 * Shared by tokenize() (validate once) and evalFilter() (evaluate per item) so
 * the two can't drift — same rule as isUpstreamError/isProbeClient.
 */
function parseFilterExpr(expr: string): ParsedFilter {
  const shown = expr.trim();
  const help = "Supported filter shape: [?(@.key op value)] with op one of = != > >= < <= =~ . Example: [?(@.price < 10)].";

  // Checked before the shape match: the lazy `(.+?)` key group happily matches
  // `@.price > 1 && @.stock > 100` as key "price", op ">", value
  // "1 && @.stock > 100" → parseFloat gives 1 and the second condition is
  // silently dropped, returning a WRONG non-empty result rather than an empty
  // one. Verified against the live tool on 2026-07-25.
  if (hasUnquotedLogicalOp(shown)) {
    throw new Error(
      `Filter "${shown}" uses a compound condition (&& / ||), which is not supported — it would silently ignore all but the first condition. Apply one condition per query and narrow further with a second query. ${help}`
    );
  }

  const m = shown.match(/^@\.(.+?)\s*(=~|!=|>=|<=|>|<|=)\s*(.+)$/);
  if (!m) {
    const hint = /^@\.[^\s=<>!~]+$/.test(shown)
      ? " Existence checks are not supported: compare explicitly, e.g. [?(@.name != '')]."
      : shown.startsWith(".") || shown.startsWith("@[")
        ? " Fields must be written as @.key (jq and bracket forms are not supported here)."
        : "";
    throw new Error(`Invalid filter "${shown}": no comparison found.${hint} ${help}`);
  }

  const [, key, op, rawVal] = m;
  const parsed: ParsedFilter = { key, op, valStr: rawVal.trim().replace(/^["']|["']$/g, "") };

  if (op === "=~") {
    const regexMatch = rawVal.trim().match(/^\/(.+)\/([gimu]*)$/);
    if (!regexMatch) {
      throw new Error(`Invalid filter "${shown}": =~ needs a /regex/ literal, e.g. [?(@.name =~ /^Al/)].`);
    }
    try {
      parsed.regex = new RegExp(regexMatch[1], regexMatch[2]);
    } catch (err) {
      throw new Error(
        `Invalid filter "${shown}": ${err instanceof Error ? err.message : "bad regular expression"}.`
      );
    }
  }

  return parsed;
}

function evalFilter(item: JSONValue, filter: ParsedFilter): boolean {
  const { key, op, valStr, regex } = filter;
  const actual = getNestedKey(item, key);
  // Data-dependent: the key is absent from THIS item. A legitimate no-match,
  // never a syntax problem — must stay silent.
  if (actual === undefined) return false;

  if (op === "=~") return regex!.test(String(actual));

  const actualNum = typeof actual === "number" ? actual : parseFloat(String(actual));
  const valNum = parseFloat(valStr);

  switch (op) {
    case "=":
      return String(actual).toLowerCase() === valStr.toLowerCase();
    case "!=":
      return String(actual).toLowerCase() !== valStr.toLowerCase();
    case ">":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum > valNum;
    case ">=":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum >= valNum;
    case "<":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum < valNum;
    case "<=":
      return !isNaN(actualNum) && !isNaN(valNum) && actualNum <= valNum;
    default:
      return false;
  }
}

/** Append every element of `src` to `dest` without spreading — `dest.push(...src)`
 *  throws RangeError on large arrays (engines cap spread/apply argument counts). */
function pushAll<T>(dest: T[], src: readonly T[]): void {
  for (const item of src) dest.push(item);
}

function getNestedKey(obj: JSONValue, key: string): JSONValue | undefined {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return undefined;
  }
  return (obj as Record<string, JSONValue>)[key];
}

// ---------------------------------------------------------------------------
// Path evaluator
// ---------------------------------------------------------------------------

function evalTokens(
  nodes: JSONValue[],
  tokens: Token[],
  startIdx: number
): JSONValue[] {
  if (startIdx >= tokens.length) return nodes;

  const token = tokens[startIdx];
  const results: JSONValue[] = [];

  for (const node of nodes) {
    switch (token.t) {
      case "root":
        results.push(node);
        break;

      case "dot":
      case "bracket": {
        const key = token.t === "dot" ? token.key : token.key;
        if (node !== null && typeof node === "object" && !Array.isArray(node)) {
          const val = (node as Record<string, JSONValue>)[key];
          if (val !== undefined) results.push(val);
        }
        break;
      }

      case "index": {
        if (Array.isArray(node)) {
          const idx = token.idx < 0 ? node.length + token.idx : token.idx;
          if (idx >= 0 && idx < node.length) results.push(node[idx]);
        }
        break;
      }

      case "wildcard": {
        if (Array.isArray(node)) {
          pushAll(results, node);
        } else if (node !== null && typeof node === "object") {
          pushAll(results, Object.values(node as Record<string, JSONValue>));
        }
        break;
      }

      case "recursive": {
        // Find all occurrences of key in the subtree
        pushAll(results, findRecursive(node, token.key));
        break;
      }

      case "filter": {
        if (Array.isArray(node)) {
          pushAll(results, node.filter((item) => evalFilter(item, token.filter)));
        }
        break;
      }
    }
  }

  return evalTokens(results, tokens, startIdx + 1);
}

function findRecursive(node: JSONValue, key: string): JSONValue[] {
  const results: JSONValue[] = [];
  if (node === null || typeof node !== "object") return results;

  if (Array.isArray(node)) {
    for (const item of node) {
      pushAll(results, findRecursive(item, key));
    }
  } else {
    const obj = node as Record<string, JSONValue>;
    if (key in obj) results.push(obj[key]);
    for (const val of Object.values(obj)) {
      pushAll(results, findRecursive(val, key));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

interface JsonQueryEngineOptions {
  toolName: string;
  allowInline: boolean;
  maxBytes: number;
  fetchTimeoutMs: number;
  tooLargeHint: string;
}

async function runJsonQuery(args: Record<string, unknown>, opts: JsonQueryEngineOptions, filesEnv?: FilesEnv): Promise<string> {
  if (typeof args.query !== "string" || !args.query.trim()) {
    // Fase 25.6 — hit 4× in one day by a real caller who clearly wanted to
    // look at the document before knowing its shape. `$` already does that;
    // nothing said so.
    throw new Error("`query` is required. Use `$` to return the whole document, or e.g. `$.items[*].name`.");
  }

  const hasUrl = typeof args.url === "string" && (args.url as string).length > 0;
  const hasJson = opts.allowInline && typeof args.json === "string" && (args.json as string).length > 0;

  if (!hasUrl && !hasJson) {
    throw new Error(opts.allowInline ? "Provide either `url` or `json`." : "`url` is required.");
  }
  if (hasUrl && hasJson) throw new Error("Provide either `url` or `json`, not both.");

  let rawJson: string;
  if (hasUrl) {
    const url = args.url as string;
    const forwardHeaders = parseForwardHeaders(args.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs);
    let response: Response;
    try {
      response = await safeFetch(
        url,
        {
          signal: controller.signal,
          headers: { "User-Agent": `toolsnap-mcp/1.0 (${opts.toolName}; +https://toolsnap.app)` },
        },
        { forwardHeaders, env: filesEnv }
      );
    } catch (err) {
      throw new Error(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw httpStatusError(response);
    const buf = await response.arrayBuffer();
    if (buf.byteLength > opts.maxBytes) {
      throw new Error(`JSON too large for ${opts.toolName}: ${buf.byteLength} bytes (max ${opts.maxBytes}). ${opts.tooLargeHint}`);
    }
    rawJson = new TextDecoder().decode(buf);
  } else {
    rawJson = args.json as string;
  }

  let data: JSONValue;
  try {
    data = JSON.parse(rawJson) as JSONValue;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fase 25.10 — mismo tratamiento que pdf_text_extract (Fase 25.6): decir
    // QUE llego, no solo que no era JSON. "Invalid JSON: Unexpected token
    // '<', \"<!DOCTYPE \"..." dejaba al agente sin siguiente paso, y el caso
    // es siempre el mismo: la URL sirve una pagina HTML (landing, muro de
    // cookies/login, o un 404 con status 200), no el endpoint JSON.
    //
    // El prefijo tambien es semantico, no cosmetico: `Invalid JSON from the
    // URL:` lo clasifica como "upstream" y `Invalid JSON:` (el `json` inline,
    // que solo pudo escribir el llamante) como "caller". Ver
    // src/alerts/error-classification.ts — cambiar estos textos sin tocar
    // alli devuelve el fallo al pager.
    if (!hasUrl) throw new Error(`Invalid JSON: ${message}`);
    const head = rawJson.trimStart().slice(0, 200).toLowerCase();
    const looksHtml =
      head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml");
    throw new Error(
      looksHtml
        ? "Invalid JSON from the URL: the server returned an HTML page, not JSON (often a landing page, a cookie/login wall, or an error page served with status 200). Use `fetch_extract` to read it as text, `html_table_extract` if the data is in a <table>, or check that the URL points at the JSON endpoint itself."
        : `Invalid JSON from the URL: ${message}. The response is not parseable JSON — check the URL returns raw JSON (not JSONP, NDJSON or an HTML wrapper).`
    );
  }

  // Parse and evaluate the path
  let tokens: Token[];
  try {
    tokens = tokenize((args.query as string).trim());
  } catch (err) {
    // Fase 25.4 — "Expected ] at position 7" alone told the agent nothing
    // about which dialect this is (4 occurrences from one real caller in the
    // 2026-07-25 review, retrying jq/full-JSONPath syntax). Name the supported
    // subset and show a working query. Fase 25.5: filter errors are already
    // specific and self-explanatory, so they don't get the generic tail.
    const message = err instanceof Error ? err.message : String(err);
    if (/^(Invalid )?[Ff]ilter /.test(message)) throw new Error(`Invalid query: ${message}`);
    throw new Error(
      `Invalid query: ${message}. ` +
        "This is JSONPath-lite: $.a.b, $.items[0], $.items[*].name, $['key'], ..key (recursive) " +
        "and single-condition filters [?(@.price < 10)]. Slices ([0:2]) and jq syntax are not supported. " +
        "Example: '$.users[*].name'."
    );
  }

  // Start evaluation from root
  const results = evalTokens([data], tokens, 1); // skip root token; data IS the root

  // Limit
  const rawLimit = args.limit !== undefined ? Number(args.limit) : 100;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 1000);
  const total = results.length;
  const sliced = results.slice(0, limit);
  const truncated = total > limit;

  const output = sliced.length === 1 ? sliced[0] : sliced;

  return JSON.stringify(
    truncated ? { results: output, total, returned: sliced.length } : output,
    null,
    2
  );
}

export const jsonQueryTool: McpTool = {
  name: "json_query",
  description:
    "Free, read-only. JSONPath-lite query on JSON from a URL or an inline string (one of the two). Returns matches as JSON: one match bare, several as an array. Supports $, .key, ['key'], [0], [-1], [*], ..key and [?(@.k op v)]; no slices or jq. Errors on invalid JSON or over 5 MB (json_query_xl: paid, 25 MB).",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "JSON URL, max 5 MB. Not with json." },
      json: { type: "string", description: "Inline JSON text. Not with url." },
      query: { type: "string", description: "Starts with $: '$.users[*].name', '$..price', '$.items[?(@.price<10)].id'. Filter ops: = != > >= < <= =~. '$' = whole document." },
      limit: { type: "number", description: "Default 100, max 1000. Above it: {results,total,returned}." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["query"],
  },
  run() {
    throw new Error("json_query is env-aware and must be called via runWithEnv");
  },
  runWithEnv(args, env) {
    return runJsonQuery(
      args,
      {
        toolName: "json_query",
        allowInline: true,
        maxBytes: MAX_JSON_BYTES,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
        tooLargeHint:
          "Use `json_query_xl` (paid: $0.02/call or $0.01 prepaid, up to 25 MB) with the same url and query.",
      },
      env as Env
    );
  },
};

export const jsonQueryXlTool: McpTool = {
  name: "json_query_xl",
  description:
    "Paid sibling of json_query for larger URL-hosted JSON (up to 25 MB, vs 5 MB free). Same JSONPath-lite query language. URL-only (no inline json — a 25 MB payload would blow out your context anyway). $0.02/call pay-per-call or $0.01 prepaid; no first-call-free (a paid file-size tier, not a marketing freebie). Below 5 MB, use the free json_query instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "JSON URL." },
      query: { type: "string", description: "e.g. '$.users[*].name'." },
      limit: { type: "number", description: "Max results." },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
    required: ["url", "query"],
  },
  run() {
    throw new Error("json_query_xl is env-aware and must be called via runWithEnv");
  },
  runWithEnv(args, env) {
    return runJsonQuery(
      args,
      {
        toolName: "json_query_xl",
        allowInline: false,
        maxBytes: XL_MAX_JSON_BYTES,
        fetchTimeoutMs: XL_FETCH_TIMEOUT_MS,
        tooLargeHint: "This file exceeds even json_query_xl's 25 MB cap.",
      },
      env as Env
    );
  },
};
