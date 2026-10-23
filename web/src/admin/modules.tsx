import type { ComponentType } from "react";
import type { Permission, StaffMe } from "@brookclean/shared";
import { OrdersScreen } from "./Orders.tsx";
import { NewOrderScreen } from "./NewOrder.tsx";
import { TripsScreen } from "./Trips.tsx";
import { ReviewsScreen } from "./Reviews.tsx";
import { PartnersScreen } from "./Partners.tsx";
import { StaffScreen } from "./Staff.tsx";
import { SecurityScreen } from "./Security.tsx";
import { ActsScreen } from "./Acts.tsx";
import { DriversScreen } from "./Drivers.tsx";

export interface AdminModule {
  id: string;
  title: string;
  /** Раздел виден сотрудникам хотя бы с одним из этих прав (см. ROLES в shared/src/staff.ts). */
  perms: Permission[];
  /** path — текущий адрес, для разделов со своими подстраницами (/admin/trips/R-01). */
  component: ComponentType<{ me: StaffMe; path: string }>;
}

// Новый раздел панели: компонент + строка здесь + право в PERMISSIONS
export const visibleModules = (me: StaffMe) => MODULES.filter((m) => m.perms.some((p) => me.perms.includes(p)));

export const MODULES: AdminModule[] = [
  { id: "orders", title: "Заявки", perms: ["orders.read"], component: OrdersScreen },
  { id: "new", title: "Оформить заявку", perms: ["orders.create"], component: NewOrderScreen },
  { id: "acts", title: "Приёмка", perms: ["acts.read"], component: ActsScreen },
  { id: "trips", title: "Рейсы и отчёты", perms: ["trips.read", "trips.driver"], component: TripsScreen },
  { id: "drivers", title: "Водители", perms: ["drivers.edit", "trips.driver"], component: DriversScreen },
  { id: "reviews", title: "Отзывы", perms: ["reviews.read"], component: ReviewsScreen },
  { id: "partners", title: "Партнёры", perms: ["partners.edit"], component: PartnersScreen },
  { id: "staff", title: "Сотрудники", perms: ["staff.manage"], component: StaffScreen },
  { id: "security", title: "Защита", perms: ["security.manage"], component: SecurityScreen },
];
