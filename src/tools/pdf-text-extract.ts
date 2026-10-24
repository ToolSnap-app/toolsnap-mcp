import type { McpTool } from "../mcp/types.js";
import { safeFetch, httpStatusError, parseForwardHeaders, HEADERS_SCHEMA_PROPERTY, type FilesEnv } from "./safe-fetch.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PDF_BYTES = 20_000_000; // 20 MB — URL fetch cap
const MAX_INLINE_PDF_BYTES = 5_000_000; // 5 MB decoded — inline base64 cap (matches csv/json inline)
const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 100_000;

const LATIN1 = new TextDecoder("latin1");

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/** Copy Uint8Array into a plain ArrayBuffer (avoids SharedArrayBuffer type issues). */
function toPlainArrayBuffer(data: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  return ab;
}

/** Find the byte offset of `needle` in `hay`, starting at `from`. Returns -1 if absent. */
function indexOfBytes(hay: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// `stream` and `endstream` keyword byte patterns.
const STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "stream"
const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"

// ---------------------------------------------------------------------------
// Decompression (zlib/FlateDecode)
// ---------------------------------------------------------------------------

async function decompressZlib(data: Uint8Array): Promise<Uint8Array | null> {
  const tryWith = async (
    format: "deflate" | "deflate-raw",
  ): Promise<Uint8Array | null> => {
    try {
      const ab = toPlainArrayBuffer(data);
      const blob = new Blob([ab]);
      const ds = new DecompressionStream(format);
      const decompressed = blob.stream().pipeThrough(ds);
      const buf = await new Response(decompressed).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  };

  // Most PDF FlateDecode streams carry a zlib header → "deflate". Some are raw.
  return (await tryWith("deflate")) ?? (await tryWith("deflate-raw"));
}

// ---------------------------------------------------------------------------
// Encryption (Standard security handler, RC4, empty user password)
//
// Many "normal" PDFs are encrypted with an empty user password (read-protected
// but openable by any viewer). Their content streams are RC4-encrypted *before*
// being FlateDecode-compressed, so we must decrypt first or inflate fails.
// We implement just enough of the Standard handler (V1/V2, RC4) to handle the
// common empty-password case. AES (V4/V5) is not supported.
// ---------------------------------------------------------------------------

const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff,
  0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

interface EncryptionInfo {
  fileKey: Uint8Array;
  keyLen: number;
}

async function md5(...parts: Uint8Array[]): Promise<Uint8Array> {
  // Web Crypto has no MD5, so implement it inline (small, dependency-free).
  let total = 0;
  for (const p of parts) total += p.length;
  const msg = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    msg.set(p, off);
    off += p.length;
  }
  return md5Sync(msg);
}

/** Self-contained MD5 (returns 16 bytes). */
function md5Sync(input: Uint8Array): Uint8Array {
  function rotl(x: number, c: number): number {
    return (x << c) | (x >>> (32 - c));
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }

  const origLen = input.length;
  const bitLen = origLen * 8;
  // Pad to 56 mod 64, append 0x80 then length.
  const padded = new Uint8Array(((origLen + 8) >> 6) * 64 + 64);
  padded.set(input);
  padded[origLen] = 0x80;
  // 64-bit little-endian length (low 32 bits suffice for our sizes).
  padded[padded.length - 8] = bitLen & 0xff;
  padded[padded.length - 7] = (bitLen >>> 8) & 0xff;
  padded[padded.length - 6] = (bitLen >>> 16) & 0xff;
  padded[padded.length - 5] = (bitLen >>> 24) & 0xff;

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4;
      M[i] =
        padded[j] |
        (padded[j + 1] << 8) |
        (padded[j + 2] << 16) |
        (padded[j + 3] << 24);
    }
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, s[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

/** RC4 stream cipher (symmetric: same routine encrypts and decrypts). */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) sbox[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + sbox[i] + key[i % key.length]) & 0xff;
    const t = sbox[i];
    sbox[i] = sbox[j];
    sbox[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0,
    b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + 1) & 0xff;
    b = (b + sbox[a]) & 0xff;
    const t = sbox[a];
    sbox[a] = sbox[b];
    sbox[b] = t;
    out[i] = data[i] ^ sbox[(sbox[a] + sbox[b]) & 0xff];
  }
  return out;
}

/**
 * Parse a PDF string literal beginning at byte `start` (the `(` byte) directly
 * from the byte array, honoring escapes — needed because /O and /U contain
 * arbitrary binary including escaped bytes.
 */
function parseLiteralStringBytes(bytes: Uint8Array, start: number): Uint8Array {
  const out: number[] = [];
  let i = start + 1;
  let depth = 1;
  while (i < bytes.length && depth > 0) {
    const c = bytes[i];
    if (c === 0x5c) {
      // backslash
      const n = bytes[i + 1];
      if (n >= 0x30 && n <= 0x37) {
        // octal \ddd
        let oct = "";
        let k = i + 1;
        while (k < bytes.length && oct.length < 3 && bytes[k] >= 0x30 && bytes[k] <= 0x37) {
          oct += String.fromCharCode(bytes[k++]);
        }
        out.push(parseInt(oct, 8) & 0xff);
        i = k;
        continue;
      }
      const map: Record<number, number> = {
        0x6e: 0x0a, // n
        0x72: 0x0d, // r
        0x74: 0x09, // t
        0x62: 0x08, // b
        0x66: 0x0c, // f
        0x28: 0x28, // (
        0x29: 0x29, // )
        0x5c: 0x5c, // backslash
      };
      if (n in map) {
        out.push(map[n]);
        i += 2;
        continue;
      }
      // Unknown escape: per spec the backslash is ignored, keep next byte.
      out.push(n);
      i += 2;
      continue;
    } else if (c === 0x28) {
      depth++;
      out.push(0x28);
      i++;
    } else if (c === 0x29) {
      depth--;
      if (depth > 0) out.push(0x29);
      i++;
    } else {
      out.push(c);
      i++;
    }
  }
  return Uint8Array.from(out);
}

/** Read a hex string `<...>` starting at byte `start` (the `<` byte). */
function parseHexStringBytes(bytes: Uint8Array, start: number): Uint8Array {
  let hex = "";
  let i = start + 1;
  while (i < bytes.length && bytes[i] !== 0x3e) {
    const c = bytes[i];
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
      hex += String.fromCharCode(c);
    }
    i++;
  }
  if (hex.length % 2 === 1) hex += "0";
  const out = new Uint8Array(hex.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16);
  return out;
}

/**
 * Locate and parse the Standard encryption dictionary plus the first /ID array
 * element, deriving the RC4 file key for the empty user password.
 * Returns null when the PDF is unencrypted or uses an unsupported scheme.
 */
async function getEncryptionInfo(bytes: Uint8Array): Promise<EncryptionInfo | null> {
  const text = LATIN1.decode(bytes);

  // Must reference an Encrypt entry in the trailer to be encrypted.
  if (!/\/Encrypt\b/.test(text)) return null;

  // Find the Standard security handler dictionary.
  const stdIdx = text.indexOf("/Filter/Standard");
  const stdIdx2 = stdIdx === -1 ? text.indexOf("/Filter /Standard") : stdIdx;
  if (stdIdx2 === -1) return null;

  // Isolate the encrypt object's *own* dictionary so we never read a /Length,
  // /O etc. that belongs to a neighbouring object. Scan backward to the `<<`
  // that opens this dict, then forward to its matching `>>`.
  const dictStart = openingDictBefore(text, stdIdx2);
  const dictEnd = matchingDictClose(text, dictStart);
  const dictText = text.slice(dictStart, dictEnd);

  const vMatch = dictText.match(/\/V\s+(\d+)/);
  const rMatch = dictText.match(/\/R\s+(\d+)/);
  const pMatch = dictText.match(/\/P\s+(-?\d+)/);
  if (!vMatch || !rMatch || !pMatch) return null;

  const V = parseInt(vMatch[1], 10);
  const R = parseInt(rMatch[1], 10);
  // Only RC4-based handlers (V1/V2, R2/R3) are supported.
  if (V > 2 || R > 4) return null;

  const P = parseInt(pMatch[1], 10) | 0; // signed 32-bit
  const lengthMatch = dictText.match(/\/Length\s+(\d+)/);
  // /Length here is in bits; default 40 bits for V1.
  const keyLen = lengthMatch ? Math.floor(parseInt(lengthMatch[1], 10) / 8) : 5;

  // Extract /O (owner) string — a 32-byte literal or hex string — searching
  // only within this dict's byte range (latin1 char index == byte index).
  const oByteIdx = findFieldStringStart(bytes, dictStart, dictEnd, "/O");
  const uByteIdx = findFieldStringStart(bytes, dictStart, dictEnd, "/U");
  if (oByteIdx === null || uByteIdx === null) return null;
  const O = readStringAt(bytes, oByteIdx);
  if (O.length < 32) return null;

  // First /ID array element.
  const idMatch = text.match(/\/ID\s*\[\s*<([0-9A-Fa-f]+)>/);
  let ID: Uint8Array;
  if (idMatch) {
    const hex = idMatch[1];
    ID = new Uint8Array(hex.length / 2);
    for (let k = 0; k < ID.length; k++) ID[k] = parseInt(hex.substr(k * 2, 2), 16);
  } else {
    // Some PDFs use a literal string ID; fall back to empty.
    ID = new Uint8Array(0);
  }

  // Algorithm 2: compute the file encryption key for an empty user password.
  const pBytes = Uint8Array.from([
    P & 0xff,
    (P >>> 8) & 0xff,
    (P >>> 16) & 0xff,
    (P >>> 24) & 0xff,
  ]);

  let key = await md5(PASSWORD_PAD, O.slice(0, 32), pBytes, ID);
  if (R >= 3) {
    for (let i = 0; i < 50; i++) {
      key = md5Sync(key.slice(0, keyLen));
    }
  }
  const fileKey = key.slice(0, keyLen);

  return { fileKey, keyLen };
}

/** Index of the `<<` that opens the dictionary enclosing `pos` (scan backward). */
function openingDictBefore(text: string, pos: number): number {
  const open = text.lastIndexOf("<<", pos);
  return open === -1 ? 0 : open;
}

/** Index just past the `>>` that closes the dict opened at `dictStart`. */
function matchingDictClose(text: string, dictStart: number): number {
  let depth = 0;
  let i = dictStart;
  while (i < text.length - 1) {
    if (text[i] === "<" && text[i + 1] === "<") {
      depth++;
      i += 2;
    } else if (text[i] === ">" && text[i + 1] === ">") {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return text.length;
}

/**
 * Find the byte offset of the `(` or `<` that begins the string value of a
 * named field (e.g. "/O"), searching only within [from, to). Returns null if
 * not found.
 */
function findFieldStringStart(
  bytes: Uint8Array,
  from: number,
  to: number,
  name: string,
): number | null {
  const nameBytes = name.split("").map((c) => c.charCodeAt(0));
  let idx = indexOfBytes(bytes, nameBytes, from);
  while (idx !== -1 && idx < to) {
    // Ensure the char after the name isn't an alnum (avoid /Op matching /O).
    let p = idx + nameBytes.length;
    const after = bytes[p];
    const isAlnum =
      (after >= 0x30 && after <= 0x39) ||
      (after >= 0x41 && after <= 0x5a) ||
      (after >= 0x61 && after <= 0x7a);
    if (!isAlnum) {
      // Skip whitespace to the delimiter.
      while (p < bytes.length && (bytes[p] === 0x20 || bytes[p] === 0x0d || bytes[p] === 0x0a || bytes[p] === 0x09)) {
        p++;
      }
      if (bytes[p] === 0x28 || bytes[p] === 0x3c) return p;
    }
    idx = indexOfBytes(bytes, nameBytes, idx + nameBytes.length);
  }
  return null;
}

/** Read a string value (literal `(` or hex `<`) at byte offset `at`. */
function readStringAt(bytes: Uint8Array, at: number): Uint8Array {
  if (bytes[at] === 0x3c) return parseHexStringBytes(bytes, at);
  return parseLiteralStringBytes(bytes, at);
}

/** Per-object RC4 key (Algorithm 1) for object number/generation. */
function objectKey(enc: EncryptionInfo, objNum: number, gen: number): Uint8Array {
  const input = new Uint8Array(enc.fileKey.length + 5);
  input.set(enc.fileKey, 0);
  input[enc.fileKey.length] = objNum & 0xff;
  input[enc.fileKey.length + 1] = (objNum >>> 8) & 0xff;
  input[enc.fileKey.length + 2] = (objNum >>> 16) & 0xff;
  input[enc.fileKey.length + 3] = gen & 0xff;
  input[enc.fileKey.length + 4] = (gen >>> 8) & 0xff;
  const hashed = md5Sync(input);
  return hashed.slice(0, Math.min(enc.keyLen + 5, 16));
}

// ---------------------------------------------------------------------------
// PDF string / text-operator decoding
// ---------------------------------------------------------------------------

/** Decode a PDF string literal (already stripped of outer parens). */
function decodePdfString(s: string): string {
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\") {
      i++;
      switch (s[i]) {
        case "n":  result += "\n"; break;
        case "r":  result += "\r"; break;
        case "t":  result += "\t"; break;
        case "b":  result += "\b"; break;
        case "f":  result += "\f"; break;
        case "(":  result += "(";  break;
        case ")":  result += ")";  break;
        case "\\": result += "\\"; break;
        default: {
          // Octal \ddd
          if (s[i] >= "0" && s[i] <= "7") {
            let oct = "";
            while (oct.length < 3 && i < s.length && s[i] >= "0" && s[i] <= "7") {
              oct += s[i++];
            }
            result += String.fromCharCode(parseInt(oct, 8));
            continue;
          }
          result += s[i];
        }
      }
      i++;
    } else {
      result += s[i++];
    }
  }
  return result;
}

/** Extract all (string) literals from a Tj/TJ content stream block. */
function extractStringsFromBlock(block: string): string[] {
  const texts: string[] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] === "(") {
      let depth = 1;
      let s = "";
      i++;
      while (i < block.length && depth > 0) {
        if (block[i] === "\\" && i + 1 < block.length) {
          s += block[i] + block[i + 1];
          i += 2;
        } else if (block[i] === "(") {
          depth++;
          s += block[i++];
        } else if (block[i] === ")") {
          depth--;
          if (depth > 0) s += block[i];
          i++;
        } else {
          s += block[i++];
        }
      }
      texts.push(decodePdfString(s));
    } else {
      i++;
    }
  }
  return texts;
}

/** Extract text from a PDF content stream (already decompressed/decrypted). */
function extractTextFromStream(stream: string): string {
  const paragraphs: string[] = [];
  const btRe = /BT\b([\s\S]*?)\bET\b/g;
  let m: RegExpExecArray | null;

  while ((m = btRe.exec(stream)) !== null) {
    const block = m[1];
    const strings = extractStringsFromBlock(block);
    if (strings.length === 0) continue;

    const text = strings
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");

    if (text) paragraphs.push(text);
  }

  return paragraphs.join("\n");
}

// ---------------------------------------------------------------------------
// Dictionary inspection (text region preceding a stream)
// ---------------------------------------------------------------------------

/** Check whether a dictionary string declares the FlateDecode filter. */
function hasFlateDecode(dict: string): boolean {
  return /\/Filter\s*(?:\[[\s\S]*?\/FlateDecode[\s\S]*?\]|\/FlateDecode)/i.test(dict);
}

/** Check for image / xref streams that hold no extractable text. */
function isNonTextStream(dict: string): boolean {
  if (/\/Subtype\s*\/Image/i.test(dict)) return true;
  if (/\/Type\s*\/XRef/i.test(dict)) return true;
  return false;
}

/**
 * Given the latin1 text immediately preceding a `stream` keyword, isolate the
 * nearest enclosing dictionary `<< ... >>`. Handles nested dictionaries by
 * balancing `<<`/`>>` from the end backwards.
 */
function nearestDictionary(region: string): string {
  // The dict ends just before "stream"; find the matching opening "<<".
  const end = region.lastIndexOf(">>");
  if (end === -1) return region;
  let depth = 0;
  let i = end;
  while (i >= 1) {
    if (region[i] === ">" && region[i - 1] === ">") {
      depth++;
      i -= 2;
    } else if (region[i] === "<" && region[i - 1] === "<") {
      depth--;
      i -= 2;
      if (depth === 0) {
        return region.slice(i + 1, end + 2);
      }
    } else {
      i--;
    }
  }
  // Fallback: from the last "<<" we can find.
  const open = region.lastIndexOf("<<");
  return open === -1 ? region : region.slice(open);
}

/** Find the object number for the object enclosing a stream at `streamPos`. */
function objectNumberBefore(text: string, streamPos: number): { num: number; gen: number } | null {
  const region = text.slice(Math.max(0, streamPos - 4000), streamPos);
  const matches = [...region.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { num: parseInt(last[1], 10), gen: parseInt(last[2], 10) };
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

async function extractPDFText(buffer: ArrayBuffer): Promise<string> {
  if (buffer.byteLength < 4) throw new Error("Not a valid PDF (too small).");

  const bytes = new Uint8Array(buffer);
  const magic = LATIN1.decode(bytes.slice(0, 5));
  if (!magic.startsWith("%PDF-")) {
    // Fase 25.6 — "Not a valid PDF file." was a dead end: the caller had no
    // idea WHAT arrived, so the usual next move was retrying the same URL.
    // Almost always the server returned an HTML page instead (a landing page,
    // a cookie wall, a 404 body served with status 200), which fetch_extract
    // handles. Name what came back and point at the tool that can read it.
    const head = LATIN1.decode(bytes.slice(0, 200)).trimStart().toLowerCase();
    const looksHtml = head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml");
    throw new Error(
      looksHtml
        ? "Not a valid PDF file: the URL returned an HTML page, not a PDF (often a landing page, a cookie/login wall, or an error page served with status 200). Use `fetch_extract` to read it, or pass the direct link to the .pdf file."
        : "Not a valid PDF file: the response does not start with the %PDF- header. Check that the URL points at the file itself rather than a viewer page."
    );
  }

  // Whole-file latin1 view is used only for *text* operations (dict parsing,
  // object lookup). Stream bytes are always sliced from `bytes` directly.
  const text = LATIN1.decode(bytes);

  // Detect (and key) Standard RC4 encryption with empty user password.
  let encryption: EncryptionInfo | null = null;
  try {
    encryption = await getEncryptionInfo(bytes);
  } catch {
    encryption = null;
  }

  const allTexts: string[] = [];

  let searchFrom = 0;
  while (true) {
    const kw = indexOfBytes(bytes, STREAM, searchFrom);
    if (kw === -1) break;

    // Reject "endstream" (the STREAM pattern also matches inside it).
    const prev3 = kw >= 3 ? LATIN1.decode(bytes.slice(kw - 3, kw)) : "";
    if (prev3 === "end") {
      searchFrom = kw + STREAM.length;
      continue;
    }

    // After the keyword, the stream data begins after CRLF, LF, or CR.
    let dataStart = kw + STREAM.length;
    if (bytes[dataStart] === 0x0d) dataStart++;
    if (bytes[dataStart] === 0x0a) dataStart++;

    // Parse the nearest preceding dictionary (bounded look-back, 4 KB).
    const dictRegionText = text.slice(Math.max(0, kw - 4000), kw);
    const dict = nearestDictionary(dictRegionText);

    // Determine the stream length: prefer a direct integer /Length; if it is an
    // indirect reference (`N 0 R`) or absent, fall back to scanning for the
    // next `endstream`.
    let dataEnd: number;
    const lenMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    if (lenMatch) {
      const declared = parseInt(lenMatch[1], 10);
      dataEnd = dataStart + declared;
      // Validate: an `endstream` should follow within a few bytes. If not, the
      // /Length was likely an indirect reference we misread → scan instead.
      const probe = indexOfBytes(bytes, ENDSTREAM, dataEnd);
      if (probe === -1 || probe - dataEnd > 4) {
        const es = indexOfBytes(bytes, ENDSTREAM, dataStart);
        if (es === -1) break;
        dataEnd = trimEol(bytes, dataStart, es);
      }
    } else {
      const es = indexOfBytes(bytes, ENDSTREAM, dataStart);
      if (es === -1) break;
      dataEnd = trimEol(bytes, dataStart, es);
    }

    // Advance the outer search past this stream regardless of outcome.
    const nextEnd = indexOfBytes(bytes, ENDSTREAM, dataStart);
    searchFrom = nextEnd === -1 ? dataEnd : nextEnd + ENDSTREAM.length;

    if (isNonTextStream(dict)) continue;

    let streamBytes: Uint8Array = bytes.slice(dataStart, dataEnd);

    // Decrypt (RC4) before any decompression.
    if (encryption) {
      const obj = objectNumberBefore(text, kw);
      if (obj) {
        const k = objectKey(encryption, obj.num, obj.gen);
        streamBytes = rc4(k, streamBytes);
      }
    }

    let decoded: string;
    if (hasFlateDecode(dict)) {
      const decompressed = await decompressZlib(streamBytes);
      if (!decompressed) continue;
      decoded = LATIN1.decode(decompressed);
    } else {
      decoded = LATIN1.decode(streamBytes);
    }

    const extracted = extractTextFromStream(decoded);
    if (extracted.trim()) allTexts.push(extracted.trim());
  }

  if (allTexts.length === 0) {
    return "(No readable text found. The PDF may be scanned/image-based, AES-encrypted, or use unsupported encoding.)";
  }

  return allTexts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Trim a trailing EOL (CRLF/LF/CR) preceding `endstream` at `es`. */
function trimEol(bytes: Uint8Array, start: number, es: number): number {
  let end = es;
  if (end > start && bytes[end - 1] === 0x0a) end--;
  if (end > start && bytes[end - 1] === 0x0d) end--;
  return end;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/** Decode a base64 string into an ArrayBuffer, capped at `maxBytes`. */
function decodeBase64Pdf(data: string, maxBytes: number): ArrayBuffer {
  let bin: string;
  try {
    bin = atob(data.replace(/\s/g, ""));
  } catch {
    throw new Error("`data` is not valid base64.");
  }
  if (bin.length > maxBytes) {
    throw new Error(`PDF too large: ${bin.length} bytes (max ${maxBytes} for inline data — use \`url\` for larger files).`);
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export const pdfTextExtractTool: McpTool = {
  name: "pdf_text_extract",
  description:
    "Free, read-only. Extract plain text from a PDF given as a URL (max 20 MB) or inline base64 (max 5 MB), one of the two. Returns text, cut at maxChars with a marker. Text-layer PDFs only: scans return little or nothing (no OCR). Layout and tables are not preserved. Fails if the URL serves HTML, not a PDF.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Direct link to the .pdf file, not a viewer page. Not with data." },
      data: { type: "string", description: "Base64 PDF, max 5 MB decoded. Not with url." },
      maxChars: { type: "number", description: `Output cap, chars. Default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}.` },
      headers: HEADERS_SCHEMA_PROPERTY,
    },
  },
  run() {
    throw new Error("pdf_text_extract is env-aware and must be called via runWithEnv");
  },
  async runWithEnv(args, env) {
    const hasUrl = typeof args.url === "string" && args.url.length > 0;
    const hasData = typeof args.data === "string" && args.data.length > 0;

    if (!hasUrl && !hasData) throw new Error("Provide either `url` or `data`.");
    if (hasUrl && hasData) throw new Error("Provide either `url` or `data`, not both.");

    const rawMax = args.maxChars !== undefined ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
    const maxChars = Math.min(Math.max(1, Math.floor(rawMax)), HARD_MAX_CHARS);

    let buf: ArrayBuffer;

    if (hasData) {
      buf = decodeBase64Pdf(args.data as string, MAX_INLINE_PDF_BYTES);
    } else {
      const url = args.url as string;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("`url` must start with http:// or https://");
      }
      const forwardHeaders = parseForwardHeaders(args.headers);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await safeFetch(
          url,
          {
            signal: controller.signal,
            headers: { "User-Agent": "toolsnap-mcp/1.0 (pdf_text_extract; +https://toolsnap.app)" },
          },
          { forwardHeaders, env: env as FilesEnv }
        );
      } catch (err) {
        throw new Error(`Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw httpStatusError(response);
      }

      buf = await response.arrayBuffer();
      if (buf.byteLength > MAX_PDF_BYTES) {
        throw new Error(`PDF too large: ${buf.byteLength} bytes (max ${MAX_PDF_BYTES}).`);
      }
    }

    let text = await extractPDFText(buf);

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
    }

    return text;
  },
};
