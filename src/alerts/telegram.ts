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
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const post = (parseMode: "Markdown" | null): Promise<Response> =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      }),
    });
  try {
    const res = await post("Markdown");
    if (res.ok) return true;
    // Only a 400 can be a formatting rejection; 401/403/429/5xx would fail the
    // same way in plain text, so they are not retried.
    if (res.status !== 400) return false;
    console.warn("telegram: Markdown rejected (HTTP 400), retrying as plain text");
    return (await post(null)).ok;
  } catch {
    return false;
  }
}
