import type { CarForm, CustomerForm, Quote, TrackingView } from "@brookclean/shared";

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors?: Record<string, string>) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body ? "POST" : "GET"),
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError("Нет связи с сервером. Проверьте интернет.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Ошибка сервера", res.status, data.errors);
  return data as T;
}

export interface Signature {
  method: string;
  phone: string;
  at: string;
  documentSha256: string;
}

export interface Order {
  id: string;
  no: number;
  status: string;
  createdAt: string;
  car: CarForm;
  customer: { fio: string; phone: string };
  quote: Quote;
  trackToken: string | null;
  signedAt: string | null;
  signature: Signature | null;
}

export const api = {
  partnerLink: (token: string) => call<{ partner: string; cashback: number }>(`/api/partner-links/${encodeURIComponent(token)}`),
  createOrder: (body: { car: CarForm; customer: CustomerForm; partnerToken?: string; consents: Record<string, boolean> }) =>
    call<{ id: string; no: number; quote: Quote; devCode?: string }>("/api/orders", { body }),
  resend: (id: string) => call<{ ok: true; devCode?: string }>(`/api/orders/${id}/resend`, { method: "POST" }),
  sign: (id: string, code: string) => call<Order>(`/api/orders/${id}/sign`, { body: { code } }),
  order: (id: string) => call<Order>(`/api/orders/${id}`),
  track: (token: string) => call<TrackingView>(`/api/t/${encodeURIComponent(token)}`),
  received: (token: string) => call<{ ok: true }>(`/api/t/${encodeURIComponent(token)}/received`, { method: "POST" }),
  review: (token: string, rating: number, text: string) =>
    call<{ ok: true }>(`/api/t/${encodeURIComponent(token)}/review`, { body: { rating, text } }),
};
