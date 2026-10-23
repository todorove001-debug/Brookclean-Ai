import { createHash } from "node:crypto";
import { CONTRACT_VERSION, CARRIER, consentDoc, contractDoc, docText, type ContractData } from "@brookclean/shared";

/**
 * Данные, которые клиент подписывает кодом из SMS. Хеш от них фиксируется в журнале подписи,
 * чтобы потом доказать, что PDF соответствует подписанному. textSha256 — хеш полного текста
 * договора с приложениями и согласия в той редакции шаблона, что была на момент подписи.
 */
export function contractPayload(data: ContractData) {
  return {
    template: CONTRACT_VERSION,
    carrier: { name: CARRIER.name, inn: CARRIER.inn },
    data,
    textSha256: sha256(docText(contractDoc(data)) + "\n\f\n" + docText(consentDoc(data))),
    consents: ["contract", "pep", "personal_data"],
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
