import type { ReportStatus } from "./fleet.ts";
// Права сотрудников. Новый раздел панели = новое право + строка в ROLES.

export const PERMISSIONS = {
  "orders.read": "Видеть заявки",
  "orders.create": "Оформлять заявки",
  "orders.edit": "Менять статус и рейс заявки",
  "orders.personal": "Видеть ФИО и телефоны клиентов",
  "payments.edit": "Отмечать оплату",
  "trips.read": "Видеть рейсы",
  "trips.edit": "Создавать рейсы и отмечать позицию",
  "trips.driver": "Свои рейсы: создать, загрузить машины, отметки пути, расходы",
  "reports.read": "Рейсовые отчёты",
  "reviews.read": "Отзывы клиентов",
  "partners.edit": "Ссылки партнёров",
  "staff.manage": "Сотрудники и доступы",
  "security.manage": "Защита цен: журнал и блокировки",
  "acts.read": "Акты приёма автомобилей",
  "acts.edit": "Приёмка: фото, видео, дефекты, подписи",
  "acts.manage": "Снимать отметки дефектов в подписанном акте",
  "drivers.edit": "Реестр водителей: карточки, документы, импорт из Excel",
  "staff.approve": "Подтверждать регистрацию водителей и приёмщиков",
} as const;

export type Permission = keyof typeof PERMISSIONS;
const ALL = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = {
  owner: { name: "Владелец", perms: ALL },
  manager: {
    name: "Менеджер",
    perms: ["orders.read", "orders.create", "orders.edit", "orders.personal", "trips.read", "trips.edit", "reports.read", "reviews.read", "partners.edit", "acts.read", "acts.manage", "drivers.edit", "staff.approve"],
  },
  accountant: { name: "Бухгалтер", perms: ["orders.read", "orders.personal", "payments.edit", "reports.read"] },
  acceptor: { name: "Приёмщик", perms: ["orders.read", "trips.read", "acts.read", "acts.edit"] },
  driver: { name: "Водитель", perms: ["trips.driver"] },
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
  /** Площадка приёмщика: Владивосток или терминал перегруза Новосибирск. */
  site: string | null;
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
  /** Перегруз: город терминала и рейс от терминала дальше. */
  transfer: string | null;
  trip2Id: string | null;
  trackToken: string | null;
  signedAt: string | null;
  /** Номер страхового полиса (заполняет бухгалтер или менеджер). */
  policyNo: string;
}

export interface TripView {
  id: string;
  dest: string;
  truck: string;
  driver: string;
  driverId: number | null;
  odometerStart: number | null;
  odometerEnd: number | null;
  closedAt: string | null;
  expensesTotal: number;
  /** Текущий сотрудник может менять рейс (менеджер — любой, водитель — свой открытый). */
  editable: boolean;
  loadDate: string | null;
  km: number;
  status: "loading" | "in_transit" | "arrived";
  orders: number[];
  driveUrl: string | null;
  driveError: string | null;
  driveSyncedAt: string | null;
  events: Array<{ at: string; city: string; note: string }>;
  /** Прицеп и перевозчик (собственный или компания наёмного водителя). */
  trailer: string;
  carrier: string;
  /** Карточка водителя в реестре. */
  regDriverId: number | null;
  /** Рейс сформирован: состав машин зафиксирован. */
  formedAt: string | null;
  /** Свободных мест из CAPACITY. */
  seats: number;
  advance: number;
  reportStatus: ReportStatus;
  reportComment: string;
  submittedAt: string | null;
  acceptedAt: string | null;
}

export const PAY_TO = ["Тодоров", "Ким", "Спасские Ворота"];
export const PAY_FORM = ["нал", "безнал", "перевод"];

export const EXPENSE_KINDS = {
  fuel: "Топливо",
  toll: "Платная дорога",
  parking: "Стоянка",
  repair: "Ремонт, шиномонтаж",
  wash: "Мойка",
  food: "Суточные, питание",
  other: "Прочее",
} as const;
export type ExpenseKind = keyof typeof EXPENSE_KINDS;

export interface TripExpense { id: number; at: string; kind: ExpenseKind; amount: number; liters: number | null; note: string; by: string }

export interface TripCar {
  no: number; car: string; vin: string; year: string; color: string; city: string; km: number; client: string; phone: string; status: string;
  /** Суммы и оплата — только для ролей с правом reports.read. */
  delivery?: number; insurance?: number; total?: number; paidDelivery?: boolean; paidInsurance?: boolean; payTo?: string; payForm?: string;
}

export interface TripReport {
  trip: TripView;
  cars: TripCar[];
  expenses: TripExpense[];
  totals: {
    cars: number;
    expenses: number;
    byKind: Partial<Record<ExpenseKind, number>>;
    fuelLiters: number;
    mileage: number | null;
    delivery?: number;
    insurance?: number;
    unpaid?: number;
    /** Остаток аванса у водителя (минус — перерасход, водителю вернуть). */
    balance: number;
    /** Выручка рейса по тарифам: при перегрузе — доля по километрам плеча. */
    revenue?: number;
  };
  finance: boolean;
}

export interface WaitingCar { no: number; car: string; vin: string; city: string; status: string }

/** Записи журнала защиты цен (раздел «Защита» в панели). */
export const SECURITY_KINDS = {
  sms_limit: "Слишком много SMS",
  quote_limit: "Превышен лимит расчётов",
  many_cities: "Перебирает города",
  captcha_failed: "Не прошёл капчу",
  bad_code: "Подбирает код из SMS",
  blocked: "Запрос из чёрного списка",
} as const;
export type SecurityKind = keyof typeof SECURITY_KINDS;

export interface SecurityReport {
  events: Array<{ id: number; at: number; ip: string; phone: string; kind: SecurityKind; detail: string }>;
  /** Номера и IP с записями в журнале за 7 дней: сколько расчётов и разных городов. */
  suspects: Array<{ kind: "phone" | "ip"; value: string; events: number; quotes: number; cities: number; last: number; blocked: boolean }>;
  blocked: Array<{ value: string; at: string; note: string }>;
}
