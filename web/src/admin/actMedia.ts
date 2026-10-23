// Загрузка фото и видео приёмки: фото сжимается на телефоне, файл уходит прямо в S3 по подписанной ссылке.
import { VIDEO_MAX_SECONDS, type ActView, type StageId } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO } from "../router.ts";
import { staffApi } from "./api.ts";

/** Фото с телефона → JPEG до 2000 px: для акта и ИИ достаточно, а 35 фото не съедают мобильный интернет. */
export async function shrinkPhoto(file: File, maxSide = 2000): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("Не удалось сжать фото"))), "image/jpeg", 0.85));
}

/** Длительность видео в секундах — по метаданным файла, без загрузки целиком. */
export function videoSeconds(file: File): Promise<number | undefined> {
  return new Promise((ok) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (d?: number) => { URL.revokeObjectURL(url); ok(d); };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : undefined);
    v.onerror = () => done(undefined);
    setTimeout(() => done(undefined), 8000);
    v.src = url;
  });
}

const VIDEO_TYPE: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp" };

function put(url: string, body: Blob, type: string, onProgress: (p: number) => void) {
  return new Promise<void>((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("content-type", type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? ok() : fail(new ApiError(`Хранилище не приняло файл (${x.status})`, x.status)));
    x.onerror = () => fail(new ApiError("Связь оборвалась при загрузке. Попробуйте ещё раз", 0));
    x.send(body);
  });
}

export async function uploadSlot(no: number, stage: StageId, slot: string, kind: "photo" | "video", file: File, onProgress: (p: number) => void): Promise<ActView> {
  let body: Blob = file, contentType = "image/jpeg", durationSec: number | undefined;
  if (kind === "photo") body = await shrinkPhoto(file);
  else {
    contentType = file.type || VIDEO_TYPE[file.name.split(".").pop()?.toLowerCase() ?? ""] || "video/mp4";
    if (contentType === "video/x-m4v") contentType = "video/mp4";
    durationSec = await videoSeconds(file);
    if (durationSec && durationSec > VIDEO_MAX_SECONDS + 2)
      throw new ApiError(`Видео ${Math.round(durationSec)} с — нужно не длиннее ${VIDEO_MAX_SECONDS} секунд`, 400);
  }
  const { key, url } = await staffApi.uploadUrl(no, stage, { slot, contentType, size: body.size, durationSec });
  // Демо-страница без сервера: файл остаётся в браузере
  if (DEMO) {
    for (const p of [0.3, 0.7, 1]) { onProgress(p); await new Promise((ok) => setTimeout(ok, 120)); }
    return staffApi.confirmMedia(no, stage, { slot, key, contentType, durationSec, preview: URL.createObjectURL(body) });
  }
  await put(url, body, contentType, onProgress);
  return staffApi.confirmMedia(no, stage, { slot, key, contentType, durationSec });
}
