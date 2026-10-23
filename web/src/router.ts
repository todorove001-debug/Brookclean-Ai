// Навигация по сайту. В демо-сборке (одна HTML-страница без сервера) путь хранится в памяти.
export const DEMO = import.meta.env.VITE_DEMO === "1";
export const SITE_ORIGIN = DEMO ? "https://brookclean-reg.ru" : location.origin;

let memoryPath = "/";

export function currentPath() {
  return DEMO ? memoryPath : location.pathname + location.search;
}

export function navigate(path: string) {
  if (DEMO) memoryPath = path;
  else history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo(0, 0);
}

export function searchParam(name: string) {
  const q = currentPath().split("?")[1] ?? "";
  return new URLSearchParams(q).get(name);
}
