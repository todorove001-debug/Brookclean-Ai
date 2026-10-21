import type { ComponentType } from "react";
import type { Permission, StaffMe } from "@brookclean/shared";
import { OrdersScreen } from "./Orders.tsx";
import { NewOrderScreen } from "./NewOrder.tsx";
import { TripsScreen } from "./Trips.tsx";
import { ReviewsScreen } from "./Reviews.tsx";
import { PartnersScreen } from "./Partners.tsx";
import { StaffScreen } from "./Staff.tsx";

export interface AdminModule {
  id: string;
  title: string;
  /** Раздел виден только сотрудникам с этим правом (см. ROLES в shared/src/staff.ts). */
  perm: Permission;
  component: ComponentType<{ me: StaffMe }>;
}

// Новый раздел панели: компонент + строка здесь + право в PERMISSIONS
export const MODULES: AdminModule[] = [
  { id: "orders", title: "Заявки", perm: "orders.read", component: OrdersScreen },
  { id: "new", title: "Оформить заявку", perm: "orders.create", component: NewOrderScreen },
  { id: "trips", title: "Рейсы и отчёты", perm: "trips.read", component: TripsScreen },
  { id: "reviews", title: "Отзывы", perm: "reviews.read", component: ReviewsScreen },
  { id: "partners", title: "Партнёры", perm: "partners.edit", component: PartnersScreen },
  { id: "staff", title: "Сотрудники", perm: "staff.manage", component: StaffScreen },
];
