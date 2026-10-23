// Демо: заявки на партнёрство общие для сайта клиента и панели.
import type { PartnerRequestView } from "@brookclean/shared";

export const partnerRequests: PartnerRequestView[] = [];
export const demoPartner = (phone: string) => partnerRequests.find((r) => r.phone === phone);
