// Уведомления менеджеру в Telegram: новый подписанный договор. Без TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID ничего не уходит.
export interface Notifier {
  send(text: string): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  constructor(private token: string, private chatId: string) {}
  async send(text: string) {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Telegram ответил ${r.status}`);
  }
}

/** Для тестов: сообщения складываются в память. */
export class MemoryNotifier implements Notifier {
  sent: string[] = [];
  async send(text: string) {
    this.sent.push(text);
  }
}

export function telegramFromEnv(): Notifier | undefined {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  return token && chat ? new TelegramNotifier(token, chat) : undefined;
}
