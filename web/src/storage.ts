// Локальное хранилище браузера: черновик формы и список своих заказов.
// Всё обёрнуто в try/catch: в приватном режиме доступ может быть запрещён.

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* без хранилища просто не запоминаем */
  }
}

export function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface MyOrder {
  id: string;
  no: number;
  car: string;
  city: string;
  trackToken: string;
}

export function myOrders(): MyOrder[] {
  try {
    return JSON.parse(localStorage.getItem("orders") ?? "[]");
  } catch {
    return [];
  }
}

export function rememberOrder(o: MyOrder) {
  save("orders", [o, ...myOrders().filter((x) => x.id !== o.id)].slice(0, 20));
}
