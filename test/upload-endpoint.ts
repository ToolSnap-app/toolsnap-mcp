/**
 * Tests for the out-of-band file upload feature (generalized POST /upload +
 * the R2 loopback intercept file tools now use for their own /files/ URLs +
 * pdf_text_extract's new inline `data` argument).
 *
 * Pure-function tests against a mocked R2Bucket/D1Database — no live server
 * or wrangler dev needed, same pattern as test/x402-roundtrip.ts.
 *
 * Run:  npx tsx test/upload-endpoint.ts
 */

// Fase 25.18 — src/index.ts importa el panel como modulos de texto; el hook
// tiene que registrarse antes de cargar el Worker (ver test/_support/text-modules.ts).
import "./_support/text-modules.js";
import type { Env } from "../src/index.js";
import { resolveOwnFilesResponse } from "../src/tools/safe-fetch.js";
import { pdfTextExtractTool } from "../src/tools/pdf-text-extract.js";
import { hashKey } from "../src/fiat/keys.js";

const { handleFileUpload, UPLOAD_ALLOWED_TYPES, FREE_UPLOAD_MAX_BYTES, PAID_UPLOAD_MAX_BYTES } = await import("../src/index.js");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  OK   ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Mock R2Bucket — in-memory Map, enough surface for put/get used here.
// ---------------------------------------------------------------------------

interface StoredObject {
  body: ArrayBuffer | ReadableStream;
  httpMetadata?: { contentType?: string };
}

function makeFakeR2(): { bucket: R2Bucket; store: Map<string, StoredObject> } {
  const store = new Map<string, StoredObject>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body: value, httpMetadata: opts?.httpMetadata });
      return {} as R2Object;
    },
    async get(key: string) {
      const obj = store.get(key);
      if (!obj) return null;
      let bytes: Uint8Array;
      if (obj.body instanceof ArrayBuffer) {
        bytes = new Uint8Array(obj.body);
      } else {
        const chunks: Uint8Array[] = [];
        const reader = (obj.body as ReadableStream).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.byteLength;
        }
      }
      return {
        httpMetadata: obj.httpMetadata,
        body: new Blob([bytes]).stream(),
        arrayBuffer: async () => bytes.buffer,
      } as unknown as R2ObjectBody;
    },
    async delete() {},
  } as unknown as R2Bucket;
  return { bucket, store };
}

// ---------------------------------------------------------------------------
// Mock D1Database — enough surface for verifyApiKey/debitBalance/refundDebit/
// touchKey/getBalanceMicro against a single in-memory account.
// ---------------------------------------------------------------------------

function makeFakeD1(opts: { keyHash: string; accountId: string; balanceMicro: number }): D1Database {
  const nonces = new Set<string>();
  let balance = opts.balanceMicro;

  function stmt(sql: string) {
    let boundArgs: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        boundArgs = args;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM api_keys WHERE key_hash")) {
          const [keyHash] = boundArgs as [string];
          if (keyHash !== opts.keyHash) return null;
          return { key_id: "testkey1", account_id: opts.accountId } as unknown as T;
        }
        if (sql.includes("FROM spend_nonces WHERE nonce")) {
          const [nonce] = boundArgs as [string];
          return nonces.has(nonce) ? ({ 1: 1 } as unknown as T) : null;
        }
        if (sql.includes("SELECT balance_micro FROM balances")) {
          return { balance_micro: balance } as unknown as T;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("UPDATE balances SET balance_micro = balance_micro -")) {
          const [price, , , , minBalance] = boundArgs as [number, number, number, string, number];
          if (balance >= (minBalance as number)) {
            balance -= price;
            return { meta: { changes: 1 } } as unknown as D1Result;
          }
          return { meta: { changes: 0 } } as unknown as D1Result;
        }
        if (sql.startsWith("UPDATE balances SET balance_micro = balance_micro +")) {
          const [price] = boundArgs as [number];
          balance += price;
          return { meta: { changes: 1 } } as unknown as D1Result;
        }
        if (sql.startsWith("INSERT INTO spend_nonces")) {
          const [nonce] = boundArgs as [string, string, number];
          nonces.add(nonce);
          return { meta: { changes: 1 } } as unknown as D1Result;
        }
        if (sql.startsWith("INSERT INTO ledger")) {
          return { meta: { changes: 1 } } as unknown as D1Result;
        }
        if (sql.startsWith("UPDATE api_keys SET last_used_at")) {
          return { meta: { changes: 1 } } as unknown as D1Result;
        }
        return { meta: { changes: 0 } } as unknown as D1Result;
      },
    };
  }

  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

function fakeCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function baseEnv(bucket: R2Bucket, db: D1Database): Env {
  return { SCREENSHOTS_BUCKET: bucket, PREPAID_DB: db } as unknown as Env;
}

// ---------------------------------------------------------------------------
// 1. POST /upload — free tier
// ---------------------------------------------------------------------------

async function testFreeUploadHappyPath() {
  console.log("\n[1] Free upload happy path (csv, small)");
  const { bucket } = makeFakeR2();
  const body = "a,b\n1,2\n";
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "text/csv", "Content-Length": String(body.length) },
    body,
  });
  const res = await handleFileUpload(req, baseEnv(bucket, makeFakeD1({ keyHash: "x", accountId: "a", balanceMicro: 0 })), fakeCtx());
  const json = (await res.json()) as { url: string; tier: string; content_type: string; file_size_bytes: number };
  assert(res.status === 200, `status 200 (got ${res.status})`);
  assert(json.tier === "free", `tier free (got ${json.tier})`);
  assert(json.url.startsWith("https://mcp.toolsnap.app/files/uploads/"), `url shape correct (got ${json.url})`);
  assert(json.content_type === "text/csv", `content_type echoed (got ${json.content_type})`);
  assert(json.file_size_bytes === body.length, `file_size_bytes correct (got ${json.file_size_bytes})`);
}

async function testUnsupportedContentType() {
  console.log("\n[2] Unsupported content-type -> 415");
  const { bucket } = makeFakeR2();
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "application/zip", "Content-Length": "10" },
    body: "0123456789",
  });
  const res = await handleFileUpload(req, baseEnv(bucket, makeFakeD1({ keyHash: "x", accountId: "a", balanceMicro: 0 })), fakeCtx());
  assert(res.status === 415, `status 415 (got ${res.status})`);
}

async function testMissingContentLength() {
  console.log("\n[3] Missing Content-Length -> 411");
  const { bucket } = makeFakeR2();
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: "a,b\n1,2\n",
  });
  const res = await handleFileUpload(req, baseEnv(bucket, makeFakeD1({ keyHash: "x", accountId: "a", balanceMicro: 0 })), fakeCtx());
  assert(res.status === 411, `status 411 (got ${res.status})`);
}

async function testOverPaidCeiling() {
  console.log("\n[4] Declared length over the paid 100MB ceiling -> 413");
  const { bucket } = makeFakeR2();
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "text/csv", "Content-Length": String(PAID_UPLOAD_MAX_BYTES + 1) },
    body: "x",
  });
  const res = await handleFileUpload(req, baseEnv(bucket, makeFakeD1({ keyHash: "x", accountId: "a", balanceMicro: 0 })), fakeCtx());
  assert(res.status === 413, `status 413 (got ${res.status})`);
}

async function testOverFreeWithoutKey() {
  console.log("\n[5] Declared length over free tier, no API key -> 402");
  const { bucket } = makeFakeR2();
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "text/csv", "Content-Length": String(FREE_UPLOAD_MAX_BYTES + 1000) },
    body: "x",
  });
  const res = await handleFileUpload(req, baseEnv(bucket, makeFakeD1({ keyHash: "x", accountId: "a", balanceMicro: 0 })), fakeCtx());
  const json = (await res.json()) as { error_code: string };
  assert(res.status === 402, `status 402 (got ${res.status})`);
  assert(json.error_code === "api_key_required", `error_code api_key_required (got ${json.error_code})`);
}

const TEST_RAW_KEY = "sk_live_" + "A".repeat(43);

async function testPaidUploadHappyPath() {
  console.log("\n[6a] Paid upload with a valid, funded API key -> 200, debited");
  const { bucket } = makeFakeR2();
  const keyHash = await hashKey(TEST_RAW_KEY);
  const db = makeFakeD1({ keyHash, accountId: "acct123", balanceMicro: 50_000 }); // $0.05
  const declared = FREE_UPLOAD_MAX_BYTES + 1000;
  const body = "x".repeat(declared);
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "text/csv", "Content-Length": String(declared), Authorization: `Bearer ${TEST_RAW_KEY}` },
    body,
  });
  const res = await handleFileUpload(req, baseEnv(bucket, db), fakeCtx());
  const json = (await res.json()) as { tier: string; price_usdc: string };
  assert(res.status === 200, `status 200 (got ${res.status})`);
  assert(json.tier === "paid", `tier paid (got ${json.tier})`);
  assert(json.price_usdc === "0.02", `price_usdc 0.02 (got ${json.price_usdc})`);

  const balNow = await (db.prepare("SELECT balance_micro FROM balances WHERE address = ?").bind("acct:acct123").first<{ balance_micro: number }>());
  assert(balNow?.balance_micro === 30_000, `balance debited by $0.02 (got ${balNow?.balance_micro})`);
}

async function testPaidUploadInsufficientBalance() {
  console.log("\n[6b] Paid upload with a valid but under-funded key -> 402 insufficient_balance");
  const { bucket } = makeFakeR2();
  const keyHash = await hashKey(TEST_RAW_KEY);
  const db = makeFakeD1({ keyHash, accountId: "acct123", balanceMicro: 5_000 }); // $0.005 < $0.02
  const declared = FREE_UPLOAD_MAX_BYTES + 1000;
  const req = new Request("https://mcp.toolsnap.app/upload", {
    method: "POST",
    headers: { "Content-Type": "text/csv", "Content-Length": String(declared), Authorization: `Bearer ${TEST_RAW_KEY}` },
    body: "x".repeat(declared),
  });
  const res = await handleFileUpload(req, baseEnv(bucket, db), fakeCtx());
  const json = (await res.json()) as { error_code: string };
  assert(res.status === 402, `status 402 (got ${res.status})`);
  assert(json.error_code === "insufficient_balance", `error_code insufficient_balance (got ${json.error_code})`);
}

async function testAllTypesRegistered() {
  console.log("\n[6] Every file-tool content-type is in UPLOAD_ALLOWED_TYPES");
  for (const ct of ["text/csv", "application/json", "application/pdf", "text/html", "image/png"]) {
    assert(ct in UPLOAD_ALLOWED_TYPES, `${ct} registered`);
  }
}

// ---------------------------------------------------------------------------
// 2. resolveOwnFilesResponse — the R2 loopback intercept
// ---------------------------------------------------------------------------

async function testResolveOwnFilesResponse() {
  console.log("\n[7] resolveOwnFilesResponse (R2 loopback intercept)");
  const { bucket, store } = makeFakeR2();
  store.set("uploads/abc.csv", { body: new TextEncoder().encode("a,b\n1,2\n").buffer, httpMetadata: { contentType: "text/csv" } });

  const own = await resolveOwnFilesResponse("https://mcp.toolsnap.app/files/uploads/abc.csv", { SCREENSHOTS_BUCKET: bucket });
  assert(own !== null, "own /files/ URL resolves to a Response");
  assert(own?.status === 200, `status 200 (got ${own?.status})`);
  assert(own?.headers.get("content-type") === "text/csv", `content-type preserved (got ${own?.headers.get("content-type")})`);

  const missing = await resolveOwnFilesResponse("https://mcp.toolsnap.app/files/uploads/nope.csv", { SCREENSHOTS_BUCKET: bucket });
  assert(missing?.status === 404, `missing key -> 404 (got ${missing?.status})`);

  const external = await resolveOwnFilesResponse("https://example.com/files/uploads/abc.csv", { SCREENSHOTS_BUCKET: bucket });
  assert(external === null, "different host -> null (falls through to a real fetch)");

  const notFiles = await resolveOwnFilesResponse("https://mcp.toolsnap.app/other/path", { SCREENSHOTS_BUCKET: bucket });
  assert(notFiles === null, "non-/files/ path on our own host -> null");
}

// ---------------------------------------------------------------------------
// 3. pdf_text_extract — inline `data` argument
// ---------------------------------------------------------------------------

/** A minimal, valid, uncompressed single-page PDF with one text run ("Hello"). */
function buildMinimalPdf(): Uint8Array {
  const content = "BT /F1 24 Tf 10 100 Td (Hello) Tj ET";
  // Deliberately wrong /Length (999) to also exercise extractPDFText's
  // fallback-to-endstream-scan path, not just the declared-length fast path.
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 999 >>
stream
${content}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
  return new TextEncoder().encode(pdf);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function testPdfInlineData() {
  console.log("\n[8] pdf_text_extract with inline `data`");
  const { bucket } = makeFakeR2();
  const env = { SCREENSHOTS_BUCKET: bucket } as unknown as Env;

  const b64 = toBase64(buildMinimalPdf());
  const text = await pdfTextExtractTool.runWithEnv!({ data: b64 }, env);
  assert(text.includes("Hello"), `extracted text contains "Hello" (got: ${JSON.stringify(text.slice(0, 80))})`);

  let threwBoth = false;
  try {
    await pdfTextExtractTool.runWithEnv!({ data: b64, url: "https://example.com/x.pdf" }, env);
  } catch {
    threwBoth = true;
  }
  assert(threwBoth, "url + data together throws");

  let threwNeither = false;
  try {
    await pdfTextExtractTool.runWithEnv!({}, env);
  } catch {
    threwNeither = true;
  }
  assert(threwNeither, "neither url nor data throws");

  let threwOversize = false;
  try {
    // ~7.5 MB of base64 decodes to > MAX_INLINE_PDF_BYTES (5 MB).
    const big = "A".repeat(10_000_000);
    await pdfTextExtractTool.runWithEnv!({ data: big }, env);
  } catch {
    threwOversize = true;
  }
  assert(threwOversize, "oversized inline data throws");
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Upload endpoint / R2 loopback / pdf inline tests ===");
  await testFreeUploadHappyPath();
  await testUnsupportedContentType();
  await testMissingContentLength();
  await testOverPaidCeiling();
  await testOverFreeWithoutKey();
  await testPaidUploadHappyPath();
  await testPaidUploadInsufficientBalance();
  await testAllTypesRegistered();
  await testResolveOwnFilesResponse();
  await testPdfInlineData();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
}

main();
