// имена папок и файлов в хранилище: одна папка на машину, внутри — папка на каждую передачу
import { STAGES, type Stage } from "./stages.js";

export const slug = (t: string) => String(t).replace(/[°«»"'.,:;()\/·]/g, "").trim().replace(/\s+/g, "-");
export const nn = (i: number) => String(i + 1).padStart(2, "0");

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "application/pdf": "pdf",
};
export function extOf(mime: string | undefined, name: string | undefined, def: string) {
  if (mime && EXT[mime]) return EXT[mime];
  const e = (name ?? "").split(".").pop();
  return e && e !== name && /^[a-z0-9]{2,5}$/i.test(e) ? e.toLowerCase() : def;
}

export const carFolder = (o: { no: number; car: string; vin: string }, year: number) => `Автомобили/${year}/${o.no}_${slug(o.car)}_${slug(o.vin)}`;

// 04_Терминал-отгрузка_2026-10-23_Новосибирск
export function stageFolder(num: number, st: Stage, date: Date, place: string) {
  const d = date.toISOString().slice(0, 10);
  return `${String(num).padStart(2, "0")}_${STAGES[st].folder}_${d}_${slug(place)}`;
}
const KIND_DIR = { photo: "Фото", video: "Видео", act: "Акт", signature: "Подписи" } as const;
export function mediaKey(base: string, kind: keyof typeof KIND_DIR, slot: number, title: string, ext: string, uniq: string) {
  return `${base}/${KIND_DIR[kind]}/${nn(slot)}_${slug(title)}_${uniq}.${ext}`;
}
