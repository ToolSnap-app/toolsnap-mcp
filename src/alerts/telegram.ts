/** Minimal shape needed to send a Telegram message — any Env satisfies this. */
export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

/**
 * Send a Telegram message via the Bot API. No-op (returns false) if the bot
 * token or chat id are not configured, so the scheduled handler is safe to ship
 * before the chat id is known.
 *
 * Fase 25.23 — the text goes out as legacy Markdown, and the alerts interpolate
 * strings we do not control (a tool's error detail, a client name, a hostname).
 * One unpaired `_`, `*`, `` ` `` or `[` and the Bot API answers 400 "can't parse
 * entities": the whole message is rejected, and before this the alert was lost
 * without a trace. A pager must not drop a page over formatting, so a 400 is
 * retried once as plain text (no parse_mode). The asterisks show up literally;
 * the alert arrives.
 */
export async function sendTelegram(env: TelegramEnv, text: string): Promise<boolean> {
  return (await sendTelegramMessage(env, text)).ok;
}

export interface TelegramSendOptions {
  /** Send as plain text from the start (text we did not write: no Markdown to break, no entities to inject). */
  plain?: boolean;
  /** Thread the message under this one. Still sent if the original is gone. */
  replyTo?: number | null;
}

export interface TelegramSendResult {
  ok: boolean;
  /** Bot API message id of what was sent, when the answer carried one. */
  messageId: number | null;
}

/** Bot API answers `{ ok, result: { message_id } }`; anything else is "sent, id unknown". */
async function readMessageId(res: Response): Promise<number | null> {
  try {
    const body = (await res.json()) as { result?: { message_id?: unknown } };
    const id = body?.result?.message_id;
    return typeof id === "number" && Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * sendTelegram() plus what the alert agent needs (src/alerts/agent.ts): the id
 * of the message that went out, so a verdict can be threaded under the alert
 * it is about, and a way to send a reply as plain text. Same contract: never
 * throws, no-op without bot token + chat id.
 */
export async function sendTelegramMessage(
  env: TelegramEnv,
  text: string,
  opts: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, messageId: null };
  const post = (parseMode: "Markdown" | null): Promise<Response> =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
        disable_web_page_preview: true,
      }),
    });
  try {
    let res = await post(opts.plain ? null : "Markdown");
    // Only a 400 can be a formatting rejection; 401/403/429/5xx would fail the
    // same way in plain text, so they are not retried.
    if (!res.ok && res.status === 400 && !opts.plain) {
      console.warn("telegram: Markdown rejected (HTTP 400), retrying as plain text");
      res = await post(null);
    }
    if (!res.ok) return { ok: false, messageId: null };
    return { ok: true, messageId: await readMessageId(res) };
  } catch {
    return { ok: false, messageId: null };
  }
}
