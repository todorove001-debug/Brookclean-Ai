// Права сотрудников. Новый раздел панели = новое право + строка в ROLES.

export const PERMISSIONS = {
  "orders.read": "Видеть заявки",
  "orders.create": "Оформлять заявки",
  "orders.edit": "Менять статус и рейс заявки",
  "orders.personal": "Видеть ФИО и телефоны клиентов",
  "payments.edit": "Отмечать оплату",
  "trips.read": "Видеть рейсы",
  "trips.edit": "Создавать рейсы и отмечать позицию",
  "reports.read": "Рейсовые отчёты",
  "reviews.read": "Отзывы клиентов",
  "partners.edit": "Ссылки партнёров",
  "staff.manage": "Сотрудники и доступы",
} as const;

export type Permission = keyof typeof PERMISSIONS;
const ALL = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = {
  owner: { name: "Владелец", perms: ALL },
  manager: {
    name: "Менеджер",
    perms: ["orders.read", "orders.create", "orders.edit", "orders.personal", "trips.read", "trips.edit", "reports.read", "reviews.read", "partners.edit"],
  },
  accountant: { name: "Бухгалтер", perms: ["orders.read", "orders.personal", "payments.edit", "reports.read"] },
  acceptor: { name: "Приёмщик", perms: ["orders.read", "trips.read"] },
} satisfies Record<string, { name: string; perms: Permission[] }>;

export type Role = keyof typeof ROLES;
export const isRole = (r: unknown): r is Role => typeof r === "string" && r in ROLES;
export const can = (role: Role, p: Permission) => (ROLES[role].perms as readonly Permission[]).includes(p);

export interface StaffMe {
  id: number;
  name: string;
  login: string;
  role: Role;
  perms: Permission[];
}

/** Строка таблицы заявок в панели. ФИО и телефон — только при праве orders.personal. */
export interface OrderRowView {
  no: number;
  id: string;
  createdAt: string;
  status: string;
  car: string;
  vin: string;
  year: string;
  color: string;
  body: string;
  city: string;
  client: string;
  phone: string;
  partner: string | null;
  tariff: number;
  cashback: number;
  delivery: number;
  value: number;
  insurance: number;
  total: number;
  paidDelivery: boolean;
  paidInsurance: boolean;
  payTo: string;
  payForm: string;
  tripId: string | null;
  trackToken: string | null;
  signedAt: string | null;
}

export interface TripView {
  id: string;
  dest: string;
  truck: string;
  driver: string;
  loadDate: string | null;
  km: number;
  status: "loading" | "in_transit" | "arrived";
  orders: number[];
  driveUrl: string | null;
  driveError: string | null;
  driveSyncedAt: string | null;
  events: Array<{ at: string; city: string; note: string }>;
}

export const PAY_TO = ["Тодоров", "Ким", "Спасские Ворота"];
export const PAY_FORM = ["нал", "безнал", "перевод"];
