// ошибка с HTTP-кодом и понятным сообщением для пользователя
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const bad = (msg: string) => new HttpError(400, msg, "bad_request");
export const unauthorized = (msg = "Нужно войти") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "Нет доступа") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Не найдено") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
