export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}

/** Заглушка для разработки: пишет SMS в лог сервера. */
export class ConsoleSms implements SmsSender {
  sent: Array<{ phone: string; text: string }> = [];
  async send(phone: string, text: string) {
    this.sent.push({ phone, text });
    console.log(`[sms] ${phone}: ${text}`);
  }
}

/**
 * SMS Aero (smsaero.ru), API v2: https://smsaero.ru/integration/documentation/api/
 * Авторизация — email аккаунта и API-ключ из личного кабинета. Подпись отправителя (sign)
 * нужно заранее согласовать в кабинете; до этого работает общая подпись «SMS Aero».
 */
export class SmsAero implements SmsSender {
  constructor(private email: string, private apiKey: string, private sign = "SMS Aero", private base = "https://gate.smsaero.ru/v2") {}

  async send(phone: string, text: string) {
    const params = new URLSearchParams({ number: phone.replace(/\D/g, ""), text, sign: this.sign });
    const res = await fetch(`${this.base}/sms/send?${params}`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`${this.email}:${this.apiKey}`).toString("base64") },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
    if (!res.ok || !data.success) throw new Error(`SMS Aero: ${data.message ?? res.status}`);
  }
}

export function smsFromEnv(): SmsSender {
  const provider = process.env.SMS_PROVIDER ?? "console";
  if (provider === "console") return new ConsoleSms();
  if (provider === "smsaero") {
    const { SMSAERO_EMAIL, SMSAERO_API_KEY, SMSAERO_SIGN } = process.env;
    if (!SMSAERO_EMAIL || !SMSAERO_API_KEY) throw new Error("Для SMS Aero нужны SMSAERO_EMAIL и SMSAERO_API_KEY");
    return new SmsAero(SMSAERO_EMAIL, SMSAERO_API_KEY, SMSAERO_SIGN || undefined);
  }
  throw new Error(`SMS_PROVIDER=${provider} не поддерживается (console | smsaero)`);
}
