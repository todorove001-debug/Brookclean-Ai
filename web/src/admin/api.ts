import type { BodyType, BackhaulRow, Deliveries, DistributionItem, DriverCard, DriverInput, ActCar, ActRow, ActView, Condition, StageId, CarForm, CustomerForm, ExpenseKind, OrderRowView, OrderStatus, PartnerCabinet, PartnerPreview, PartnerRequestView, Quote, RecognizeKind, RecognizeResult, Role, SecurityReport, StaffMe, TripReport, TripView, WaitingCar } from "@brookclean/shared";
import { call } from "../api.ts";
import { SITE_ORIGIN } from "../router.ts";

/** Панель работает на staff.<домен>: ссылки для клиентов (трекинг, партнёры) ведут на сайт клиента. */
export const CLIENT_ORIGIN = SITE_ORIGIN.replace("://staff.", "://");

export interface StaffUser { id: number; name: string; login: string; role: Role; active: boolean; createdAt: string; site: string | null; pending?: boolean; phone?: string | null }
export interface ReviewRow { no: number; client: string; phone: string; rating: number; text: string; createdAt: string }
export interface PartnerLink { token: string; partner: string; cashback: number; createdAt: string }
export interface GoogleStatus { configured: boolean; connected: boolean; folderUrl: string | null }
export interface NewTripBody {
  dest: string; truck: string; trailer?: string; carrier?: string; driver?: string; driverId?: number | null; regDriverId?: number | null;
  loadDate?: string; odometerStart?: number | null; advance?: number;
}
export type TripPatch = Partial<{ odometerStart: number | null; odometerEnd: number | null; closed: boolean }>;
export type OrderPatch = Partial<{ status: OrderStatus; tripId: string | null; transfer: string | null; trip2Id: string | null; paidDelivery: boolean; paidInsurance: boolean; payTo: string; payForm: string; policyNo: string }>;
export type DriverPatch = Partial<DriverInput> & { active?: boolean };

export type ActPatch = Partial<{
  details: Partial<ActCar>; cond: Condition[]; condOther: string; notes: string; giveName: string; takeName: string;
  disagree: boolean; disComment: string; absent: boolean; absentReason: string;
}>;

const act = (no: number, st: StageId) => `/api/staff/acts/${no}/${st}`;
const trip = (id: string) => `/api/staff/trips/${encodeURIComponent(id)}`;

export const staffApi = {
  me: () => call<StaffMe>("/api/staff/me"),
  login: (login: string, password: string) => call<StaffMe>("/api/staff/login", { body: { login, password } }),
  logout: () => call<{ ok: true }>("/api/staff/logout", { method: "POST" }),
  orders: () => call<OrderRowView[]>("/api/staff/orders"),
  quote: (car: CarForm, cashback: number) => call<Quote>("/api/staff/quote", { body: { car, cashback } }),
  patchOrder: (no: number, patch: OrderPatch) => call<OrderRowView>(`/api/staff/orders/${no}`, { method: "PATCH", body: patch }),
  createOrder: (body: { car: CarForm; customer: CustomerForm; cashback?: number; partner?: string }) =>
    call<{ id: string; no: number; quote: Quote; signUrl: string; smsSent: boolean }>("/api/staff/orders", { body }),
  trips: () => call<TripView[]>("/api/staff/trips"),
  createTrip: (body: NewTripBody) => call<TripView>("/api/staff/trips", { body }),
  patchTrip: (id: string, body: TripPatch) => call<TripView>(`${trip(id)}`, { method: "PATCH", body }),
  drivers: () => call<Array<{ id: number; name: string }>>("/api/staff/drivers"),
  report: (id: string) => call<TripReport>(`${trip(id)}/report`),
  waiting: (id: string) => call<WaitingCar[]>(`${trip(id)}/waiting`),
  loadCar: (id: string, no: number, load: boolean) => call<TripView>(`${trip(id)}/cars`, { body: { no, load } }),
  addExpense: (id: string, body: { kind: ExpenseKind; amount: number; liters?: number | null; note?: string }) =>
    call<TripReport>(`${trip(id)}/expenses`, { body }),
  /** Фото → поля с проверками. Ничего не сохраняет: сохраняет человек после сверки. */
  recognize: (kind: RecognizeKind, image: string, prev?: string) => call<RecognizeResult>("/api/staff/recognize", { body: { kind, image, prev } }),
  deleteExpense: (id: string, eid: number) => call<TripReport>(`${trip(id)}/expenses/${eid}`, { method: "DELETE" }),
  position: (id: string, city: string, note: string) => call<TripView>(`/api/staff/trips/${encodeURIComponent(id)}/position`, { body: { city, note } }),
  syncTrip: (id: string) => call<TripView>(`/api/staff/trips/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  google: () => call<GoogleStatus>("/api/staff/google"),
  googleDisconnect: () => call<{ ok: true }>("/api/staff/google/disconnect", { method: "POST" }),
  reviews: () => call<ReviewRow[]>("/api/staff/reviews"),
  partnerLinks: () => call<PartnerLink[]>("/api/staff/partner-links"),
  partnerRequests: () => call<PartnerRequestView[]>("/api/staff/partner-requests"),
  reviewPartner: (id: number, status: "approved" | "rejected") =>
    call<PartnerRequestView>(`/api/staff/partner-requests/${id}`, { method: "PATCH", body: { status } }),
  createPartnerLink: (partner: string, cashback: number) => call<{ token: string; url: string }>("/api/staff/partner-links", { body: { partner, cashback } }),
  myPartner: () => call<PartnerCabinet>("/api/staff/my-partner"),
  partnerPreview: (city: string, body: BodyType, cashback: number) => call<PartnerPreview>("/api/staff/my-partner/preview", { body: { city, body, cashback } }),
  createMyLink: (cashback: number, note: string) => call<{ token: string; url: string }>("/api/staff/my-partner/links", { body: { cashback, note } }),
  users: () => call<StaffUser[]>("/api/staff/users"),
  createUser: (body: { name: string; login: string; password: string; role: Role; site?: string }) => call<StaffUser>("/api/staff/users", { body }),
  patchUser: (id: number, body: Partial<{ name: string; role: Role; active: boolean; password: string; site: string }>) =>
    call<StaffUser>(`/api/staff/users/${id}`, { method: "PATCH", body }),

  acts: () => call<ActRow[]>("/api/staff/acts"),
  act: (no: number, st: StageId) => call<ActView>(act(no, st)),
  patchAct: (no: number, st: StageId, body: ActPatch) => call<ActView>(act(no, st), { method: "PATCH", body }),
  uploadUrl: (no: number, st: StageId, body: { slot: string; contentType: string; size: number; durationSec?: number }) =>
    call<{ key: string; url: string }>(`${act(no, st)}/upload`, { body }),
  /** preview — только демо: файл остаётся в браузере. */
  confirmMedia: (no: number, st: StageId, body: { slot: string; key: string; contentType: string; durationSec?: number; preview?: string }) =>
    call<ActView>(`${act(no, st)}/media`, { body }),
  deleteMedia: (no: number, st: StageId, slot: string) => call<ActView>(`${act(no, st)}/media/${slot}`, { method: "DELETE" }),
  recheck: (no: number, st: StageId, slot: string) => call<ActView>(`${act(no, st)}/ai/${slot}`, { method: "POST" }),
  decide: (no: number, st: StageId, id: number, state: "yes" | "no" | "pending", code?: string) =>
    call<ActView>(`${act(no, st)}/suggestions/${id}`, { body: { state, code } }),
  addMark: (no: number, st: StageId, body: { code: string; part?: string; x: number; y: number }) => call<ActView>(`${act(no, st)}/marks`, { body }),
  patchMark: (no: number, st: StageId, id: number, body: { code?: string; part?: string }) =>
    call<ActView>(`${act(no, st)}/marks/${id}`, { method: "PATCH", body }),
  removeMark: (no: number, st: StageId, id: number, reason: string) => call<ActView>(`${act(no, st)}/marks/${id}/remove`, { body: { reason } }),
  sign: (no: number, st: StageId, who: "give" | "take", img: string, device: string) =>
    call<ActView>(`${act(no, st)}/sign`, { body: { who, img, device } }),

  // Автопарк
  registry: () => call<DriverCard[]>("/api/staff/registry"),
  createDriver: (body: Partial<DriverInput>) => call<DriverCard>("/api/staff/registry", { body }),
  patchDriver: (id: number, body: DriverPatch) => call<DriverCard>(`/api/staff/registry/${id}`, { method: "PATCH", body }),
  importDrivers: (drivers: Array<DriverInput & { importKey: string }>) => call<{ added: number; skipped: number }>("/api/staff/registry/import", { body: { drivers } }),
  myCard: () => call<DriverCard | null>("/api/staff/registry/me"),
  patchMyCard: (body: Partial<DriverInput>) => call<DriverCard>("/api/staff/registry/me", { method: "PATCH", body }),
  tripMeta: (id: string, body: Partial<{ advance: number; truck: string; trailer: string; carrier: string }>) => call<TripView>(`${trip(id)}/meta`, { body }),
  formTrip: (id: string, formed: boolean) => call<TripView>(`${trip(id)}/form`, { body: { formed } }),
  submitReport: (id: string) => call<TripReport>(`${trip(id)}/report/submit`, { method: "POST" }),
  decideReport: (id: string, accept: boolean, comment: string) => call<TripReport>(`${trip(id)}/report/decision`, { body: { accept, comment } }),
  distribution: () => call<DistributionItem[]>("/api/staff/distribution"),
  deliveries: (id: string) => call<Deliveries>(`${trip(id)}/deliveries`),
  addBackhaul: (id: string, body: { car: string; vin: string; route: string; client: string; price: number | null }) => call<BackhaulRow[]>(`${trip(id)}/backhaul`, { body }),
  deleteBackhaul: (id: string, bid: number) => call<BackhaulRow[]>(`${trip(id)}/backhaul/${bid}`, { method: "DELETE" }),
  register: (body: { name: string; phone: string; password: string; role: Role; site?: string }) => call<{ ok: true }>("/api/staff/register", { body }),
  registrations: () => call<StaffUser[]>("/api/staff/registrations"),
  decideRegistration: (id: number, approve: boolean) => call<StaffUser[]>(`/api/staff/registrations/${id}`, { body: { approve } }),

  security: () => call<SecurityReport>("/api/staff/security"),
  block: (value: string, note = "") => call<SecurityReport>("/api/staff/security/block", { body: { value, note } }),
  unblock: (value: string) => call<SecurityReport>(`/api/staff/security/block/${encodeURIComponent(value)}`, { method: "DELETE" }),
};
