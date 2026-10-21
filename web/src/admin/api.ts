import type { CarForm, CustomerForm, ExpenseKind, OrderRowView, OrderStatus, Quote, Role, StaffMe, TripReport, TripView, WaitingCar } from "@brookclean/shared";
import { call } from "../api.ts";

export interface StaffUser { id: number; name: string; login: string; role: Role; active: boolean; createdAt: string }
export interface ReviewRow { no: number; client: string; phone: string; rating: number; text: string; createdAt: string }
export interface PartnerLink { token: string; partner: string; cashback: number; createdAt: string }
export interface GoogleStatus { configured: boolean; connected: boolean; folderUrl: string | null }
export interface NewTripBody { dest: string; truck: string; driver?: string; driverId?: number | null; loadDate?: string; odometerStart?: number | null }
export type TripPatch = Partial<{ odometerStart: number | null; odometerEnd: number | null; closed: boolean }>;
export type OrderPatch = Partial<{ status: OrderStatus; tripId: string | null; paidDelivery: boolean; paidInsurance: boolean; payTo: string; payForm: string }>;

const trip = (id: string) => `/api/staff/trips/${encodeURIComponent(id)}`;

export const staffApi = {
  me: () => call<StaffMe>("/api/staff/me"),
  login: (login: string, password: string) => call<StaffMe>("/api/staff/login", { body: { login, password } }),
  logout: () => call<{ ok: true }>("/api/staff/logout", { method: "POST" }),
  orders: () => call<OrderRowView[]>("/api/staff/orders"),
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
  deleteExpense: (id: string, eid: number) => call<TripReport>(`${trip(id)}/expenses/${eid}`, { method: "DELETE" }),
  position: (id: string, city: string, note: string) => call<TripView>(`/api/staff/trips/${encodeURIComponent(id)}/position`, { body: { city, note } }),
  syncTrip: (id: string) => call<TripView>(`/api/staff/trips/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  google: () => call<GoogleStatus>("/api/staff/google"),
  googleDisconnect: () => call<{ ok: true }>("/api/staff/google/disconnect", { method: "POST" }),
  reviews: () => call<ReviewRow[]>("/api/staff/reviews"),
  partnerLinks: () => call<PartnerLink[]>("/api/staff/partner-links"),
  createPartnerLink: (partner: string, cashback: number) => call<{ token: string; url: string }>("/api/staff/partner-links", { body: { partner, cashback } }),
  users: () => call<StaffUser[]>("/api/staff/users"),
  createUser: (body: { name: string; login: string; password: string; role: Role }) => call<StaffUser>("/api/staff/users", { body }),
  patchUser: (id: number, body: Partial<{ name: string; role: Role; active: boolean; password: string }>) =>
    call<StaffUser>(`/api/staff/users/${id}`, { method: "PATCH", body }),
};
