import type { ComponentType } from "react";
import { terminalOf, type Permission, type StaffMe } from "@brookclean/shared";
import { OrdersScreen } from "./Orders.tsx";
import { NewOrderScreen } from "./NewOrder.tsx";
import { TripsScreen } from "./Trips.tsx";
import { ReviewsScreen } from "./Reviews.tsx";
import { PartnersScreen } from "./Partners.tsx";
import { StaffScreen } from "./Staff.tsx";
import { SecurityScreen } from "./Security.tsx";
import { ActsScreen } from "./Acts.tsx";
import { DriversScreen } from "./Drivers.tsx";
import { DeliveriesHub } from "./Deliveries.tsx";
import { MyPartnerScreen } from "./MyPartner.tsx";

export interface AdminModule {
  id: string;
  title: string;
  /** Раздел виден сотрудникам хотя бы с одним из этих прав (см. ROLES в shared/src/staff.ts). */
  perms: Permission[];
  /** path — текущий адрес, для разделов со своими подстраницами (/admin/trips/R-01). */
  component: ComponentType<{ me: StaffMe; path: string }>;
  /** Дополнительное условие видимости, когда одного права мало. */
  show?: (me: StaffMe) => boolean;
}

// Новый раздел панели: компонент + строка здесь + право в PERMISSIONS
export const visibleModules = (me: StaffMe) => MODULES.filter((m) => m.perms.some((p) => me.perms.includes(p)) && (m.show?.(me) ?? true));

export const MODULES: AdminModule[] = [
  { id: "orders", title: "Стоянка и заявки", perms: ["orders.read"], component: OrdersScreen },
  { id: "deliveries", title: "Доставки", perms: ["reports.read"], component: DeliveriesHub },
  { id: "new", title: "Оформить заявку", perms: ["orders.create"], component: NewOrderScreen },
  { id: "acts", title: "Приёмка", perms: ["acts.read", "acts.driver"], component: ActsScreen },
  { id: "trips", title: "Рейсы и отчёты", perms: ["trips.read", "trips.driver"], component: TripsScreen },
  // У приёмщика право drivers.site работает только на терминале: у Владивостока водители общие, их ведёт менеджер
  { id: "drivers", title: "Водители", perms: ["drivers.edit", "trips.driver", "drivers.site"], component: DriversScreen,
    show: (me) => !me.perms.includes("drivers.site") || me.perms.includes("drivers.edit") || !!terminalOf(me) },
  { id: "reviews", title: "Отзывы", perms: ["reviews.read"], component: ReviewsScreen },
  { id: "partners", title: "Партнёры", perms: ["partners.edit"], component: PartnersScreen },
  { id: "my-partner", title: "Кабинет партнёра", perms: ["partner.self"], component: MyPartnerScreen },
  { id: "staff", title: "Сотрудники", perms: ["staff.manage"], component: StaffScreen },
  { id: "security", title: "Защита", perms: ["security.manage"], component: SecurityScreen },
];
