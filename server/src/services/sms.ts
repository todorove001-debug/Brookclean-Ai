// отправка SMS с кодом подписи. Реальный провайдер (SMSC, SMS.ru) подключается здесь
export interface Sms {
  send(phone: string, text: string): Promise<void>;
}

export class ConsoleSms implements Sms {
  sent: { phone: string; text: string }[] = [];
  async send(phone: string, text: string) {
    this.sent.push({ phone, text });
    console.log(`[SMS → ${phone}] ${text}`);
  }
}
