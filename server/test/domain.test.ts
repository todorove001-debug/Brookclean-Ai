import { describe, expect, it } from "vitest";
import { quote } from "../src/domain/tariffs.js";
import { canEditMarks, canShoot, canSign, checkpointsOf, cpGate, photoSpec, vidSpec, type OrderCtx, type TripInfo, type UserCtx } from "../src/domain/stages.js";

const trip = (p: Partial<TripInfo>): TripInfo => ({ id: "t", code: "R-01", status: "forming", origin: "Владивосток", loadCity: "Владивосток", dest: "Новосибирск",
  currentCity: null, driverId: "d", driverUserId: "uA", driverName: "Водитель А", ...p });
const viaTerminal = (t2?: Partial<TripInfo>): OrderCtx => ({
  no: 1, city: "Москва", clientFio: "Иванов И. И.", transferCity: "Новосибирск",
  legs: [{ idx: 0, from: "Владивосток", to: "Новосибирск", trip: trip({}) },
    { idx: 1, from: "Новосибирск", to: "Москва", trip: trip({ id: "t2", code: "R-07", origin: "Новосибирск", loadCity: "Новосибирск", dest: "Москва", driverUserId: "uB", driverName: "Водитель Б", ...t2 }) }],
});
const insp: UserCtx = { id: "i", role: "terminal", name: "Приёмщик", terminalCity: "Новосибирск" };
const drvB: UserCtx = { id: "uB", role: "driver", name: "Водитель Б", terminalCity: null };
const drvA: UserCtx = { id: "uA", role: "driver", name: "Водитель А", terminalCity: null };

describe("тарифы", () => {
  it("кэшбэк прибавляется к перевозке, страховка 0,3%", () => {
    expect(quote("Москва", "cross", 2_000_000, 10000)).toMatchObject({ tariff: 185000, delivery: 195000, insurance: 6000, total: 201000 });
    expect(quote("Нигде", "sedan", 1_000_000)).toBeNull();
  });
});

describe("этапы передачи", () => {
  it("через терминал из Владивостока — 5 передач", () => {
    expect(checkpointsOf(viaTerminal()).map((c) => c.id)).toEqual(["priemka", "pogruzka", "term_in", "term_out", "vygruzka"]);
  });
  it("погрузка не во Владивостоке — приёмку делает водитель, без отдельной погрузки", () => {
    const o: OrderCtx = { no: 2, city: "Омск", clientFio: "К", transferCity: null, legs: [{ idx: 0, from: "Хабаровск", to: "Омск", trip: trip({ loadCity: "Хабаровск", dest: "Омск" }) }] };
    expect(checkpointsOf(o).map((c) => c.id)).toEqual(["priemka", "vygruzka"]);
    expect(canShoot(drvA, o, "priemka", undefined, false)).toBe(true);
  });
  it("отгрузка с терминала: приёмщик — 2 фото и «Сдал», водитель — приёмка и «Принял»", () => {
    const o = viaTerminal();
    expect(photoSpec("term_out").filter((s) => s.by === "terminal")).toHaveLength(2);
    expect(photoSpec("term_out").filter((s) => s.by === "driver")).toHaveLength(10);
    expect(canShoot(insp, o, "term_out", "terminal", false)).toBe(true);
    expect(canShoot(insp, o, "term_out", "driver", false)).toBe(false);
    expect(canShoot(drvB, o, "term_out", "driver", false)).toBe(true);
    expect(canEditMarks(insp, o, "term_out", false)).toBe(false);
    expect(canEditMarks(insp, o, "term_out", true)).toBe(true);   // экран передан водителю
    expect(canEditMarks(drvB, o, "term_out", false)).toBe(true);
    expect(canEditMarks(drvA, o, "term_out", false)).toBe(false);
    expect(canSign(insp, o, "term_out", "give", false)).toBe(true);
    expect(canSign(insp, o, "term_out", "take", false)).toBe(false);
    expect(canSign(drvB, o, "term_out", "give", false)).toBe(false);
    expect(canSign(drvB, o, "term_out", "take", false)).toBe(true);
  });
  it("приём на терминал: дефекты отмечает приёмщик", () => {
    expect(canEditMarks(insp, viaTerminal(), "term_in", false)).toBe(true);
    expect(canEditMarks(drvA, viaTerminal(), "term_in", false)).toBe(false);
  });
  it("облегчённая погрузка — 2 видео, погрузка во Владивостоке — без видео", () => {
    expect(vidSpec("term_out", { light: true, why: "" }).map((v) => v.slot)).toEqual([0, 4]);
    expect(vidSpec("pogruzka", { light: false, why: "" })).toEqual([]);
  });
  it("отгрузка с терминала только в сформированный рейс", () => {
    const done = new Set(["priemka", "pogruzka", "term_in"] as const);
    expect(cpGate(viaTerminal(), "term_out", new Set(done)).ok).toBe(false);
    expect(cpGate(viaTerminal({ status: "formed" }), "term_out", new Set(done)).ok).toBe(true);
  });
});
