/**
 * Unit tests for src/alerts/telegram.ts (Fase 25.23).
 *
 * Alerts go out as Telegram legacy Markdown and interpolate strings we do not
 * control: a tool's error detail, a client name, a hostname. One unpaired `_`,
 * `*`, `` ` `` or `[` and the Bot API answers 400 "can't parse entities" and
 * rejects the WHOLE message. Before this phase that alert was simply lost.
 *
 * Covers:
 *  - a well-formed message goes out once, as Markdown;
 *  - a message Markdown rejects is retried once as plain text and arrives;
 *  - only a 400 is retried: 401/429/5xx would fail the same way in plain text;
 *  - a real "tool failing for everyone" alert whose detail carries a lone
 *    underscore (`Unknown image_size …`) reaches the phone;
 *  - it still never throws, and stays a no-op without token/chat id.
 *
 * Pure logic — captured fetch. No network.
 *
 * Run: npx tsx test/telegram-plain-fallback.ts
 */
import { sendTelegram } from "../src/alerts/telegram.js";

let passed = 0;
let failed = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

/**
 * Telegram's legacy Markdown: outside code spans a lone `_`, `*` or `[` is a
 * parse error (400). Code spans (backticks) may hold anything. Same model as
 * test/deploy-watch.ts.
 */
function parsesAsLegacyMarkdown(text: string): boolean {
  const ticks = (text.match(/`/g) ?? []).length;
  if (ticks % 2 !== 0) return false;
  const outside = text.replace(/`[^`]*`/g, "");
  if (/[_\[]/.test(outside)) return false;
  return (outside.match(/\*/g) ?? []).length % 2 === 0;
}

interface Sent {
  text: string;
  parse_mode?: string;
  chat_id: string;
}

const ENV = { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "42" };
const realFetch = globalThis.fetch;

/** Fake Bot API: rejects what Markdown cannot parse, unless `status` forces an answer. */
function fakeTelegram(opts: { status?: number; plainStatus?: number; throws?: boolean } = {}): Sent[] {
  const calls: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
    if (opts.throws) throw new Error("network down");
    const body = JSON.parse(String(init?.body)) as Sent;
    calls.push(body);
    if (body.parse_mode === undefined) return new Response("{}", { status: opts.plainStatus ?? 200 });
    if (opts.status !== undefined) return new Response("{}", { status: opts.status });
    if (!parsesAsLegacyMarkdown(body.text)) {
      return new Response('{"ok":false,"description":"Bad Request: can\'t parse entities"}', { status: 400 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

const warn = console.warn;
console.warn = () => {};

try {
  console.log("\nsendTelegram");
  {
    const calls = fakeTelegram();
    const ok = await sendTelegram(ENV, "🔴 *tool fallando* · `fetch_extract`");
    assert("a well-formed message is sent once, as Markdown", ok && calls.length === 1 && calls[0]?.parse_mode === "Markdown", JSON.stringify(calls));
  }
  {
    const text = "🔴 *tool fallando* · detail: Unknown image_size [redacted]";
    const calls = fakeTelegram();
    const ok = await sendTelegram(ENV, text);
    assert("a message Markdown rejects still arrives", ok, "expected true");
    assert("…as a second call, without parse_mode", calls.length === 2 && calls[0]?.parse_mode === "Markdown" && !("parse_mode" in (calls[1] ?? {})), JSON.stringify(calls));
    assert("…with the text untouched and to the same chat", calls[1]?.text === text && calls[1]?.chat_id === "42", JSON.stringify(calls[1]));
  }
  for (const status of [401, 403, 429, 500, 502]) {
    const calls = fakeTelegram({ status });
    const ok = await sendTelegram(ENV, "hola");
    assert(`HTTP ${status} is not retried`, !ok && calls.length === 1, `ok=${ok} calls=${calls.length}`);
  }
  {
    const calls = fakeTelegram({ status: 400, plainStatus: 400 });
    const ok = await sendTelegram(ENV, "hola");
    assert("a 400 that plain text does not fix reports failure after ONE retry", !ok && calls.length === 2, `ok=${ok} calls=${calls.length}`);
  }
  {
    fakeTelegram({ throws: true });
    let threw = false;
    const ok = await sendTelegram(ENV, "hola").catch(() => {
      threw = true;
      return true;
    });
    assert("a network failure returns false and never throws", !ok && !threw, `ok=${ok} threw=${threw}`);
  }
  {
    const calls = fakeTelegram();
    const ok = (await sendTelegram({}, "hola")) || (await sendTelegram({ TELEGRAM_BOT_TOKEN: "t" }, "hola"));
    assert("without token or chat id it is a no-op", !ok && calls.length === 0, `ok=${ok} calls=${calls.length}`);
  }
} finally {
  globalThis.fetch = realFetch;
  console.warn = warn;
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
