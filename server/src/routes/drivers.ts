// базы водителей и компаний: у менеджера общая, у терминала Новосибирск — своя, общую он не видит
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { many, one } from "../db/pool.js";
import { bad, forbidden, notFound } from "../errors.js";
import { ORIGIN_CITY } from "../domain/route.js";
import { normPhone, requireUser, type AuthUser } from "../services/auth.js";
import { audit } from "../services/audit.js";

const myBase = (u: AuthUser) => (u.role === "terminal" && u.terminalCity !== ORIGIN_CITY ? u.terminalCity! : "common");

const DriverIn = z.object({
  name: z.string().trim().min(3),
  phone: z.string().max(30).nullable().optional(),
  own: z.boolean().optional(),
  companyId: z.string().uuid().nullable().optional(),
  tractorModel: z.string().max(80).nullable().optional(),
  tractorPlate: z.string().max(20).nullable().optional(),
  trailerModel: z.string().max(80).nullable().optional(),
  trailerPlate: z.string().max(20).nullable().optional(),
  // распознанные документы: паспорт, ВУ, СТС тягача и прицепа
  docs: z.record(z.record(z.string())).optional(),
});
const DCOLS: Record<string, string> = { name: "name", phone: "phone", own: "own", companyId: "company_id", tractorModel: "tractor_model", tractorPlate: "tractor_plate", trailerModel: "trailer_model", trailerPlate: "trailer_plate", docs: "docs" };

const CompanyIn = z.object({
  name: z.string().trim().min(3), shortName: z.string().nullable().optional(), inn: z.string().regex(/^\d{10}(\d{2})?$/, "ИНН — 10 или 12 цифр").nullable().optional(),
  kpp: z.string().nullable().optional(), ogrn: z.string().nullable().optional(), address: z.string().nullable().optional(), director: z.string().nullable().optional(),
  phone: z.string().nullable().optional(), email: z.string().nullable().optional(), bank: z.string().nullable().optional(), bik: z.string().nullable().optional(),
  account: z.string().nullable().optional(), corr: z.string().nullable().optional(),
});
const CCOLS: Record<string, string> = { name: "name", shortName: "short_name", inn: "inn", kpp: "kpp", ogrn: "ogrn", address: "address", director: "director", phone: "phone", email: "email", bank: "bank", bik: "bik", account: "account", corr: "corr" };

const driverOut = (d: any) => ({
  id: d.id, base: d.base, userId: d.user_id, own: d.own, name: d.name, phone: d.phone, companyId: d.company_id, companyName: d.company_name ?? null,
  tractor: { model: d.tractor_model, plate: d.tractor_plate }, trailer: { model: d.trailer_model, plate: d.trailer_plate }, docs: d.docs,
});

function setSql(b: Record<string, unknown>, cols: Record<string, string>, from = 2) {
  const keys = Object.keys(b).filter((k) => cols[k] && (b as any)[k] !== undefined);
  return { keys, sql: keys.map((k, i) => `${cols[k]} = $${i + from}`).join(", "), vals: keys.map((k) => (k === "docs" ? JSON.stringify(b[k]) : b[k])) };
}

export default async function (app: FastifyInstance) {
  const { pool } = app.deps;
  const staff = (req: any) => requireUser(pool, req, "manager", "terminal");
  const checkCompany = async (u: AuthUser, id: string | null | undefined) => {
    if (!id) return;
    const c = await one(pool, "select base from companies where id = $1", [id]);
    if (!c || c.base !== myBase(u)) throw bad("Компания не из вашей базы");
  };

  app.get("/drivers", async (req) => {
    const u = await staff(req);
    const rows = await many(pool, `select d.*, c.short_name company_name from drivers d left join companies c on c.id = d.company_id
      where d.base = $1 order by d.name`, [myBase(u)]);
    return { drivers: rows.map(driverOut) };
  });

  app.post("/drivers", async (req, reply) => {
    const u = await staff(req);
    const b = DriverIn.parse(req.body);
    await checkCompany(u, b.companyId);
    const s = setSql(b, DCOLS, 2);
    const d = await one(pool, `insert into drivers(base, ${s.keys.map((k) => DCOLS[k]).join(", ")}) values ($1, ${s.keys.map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
      [myBase(u), ...s.vals]);
    // у водителя уже есть учётная запись с этим телефоном — карточка привязывается к его кабинету
    const usr = b.phone ? await one(pool, `select id from users where role = 'driver' and status = 'active' and phone = $1
      and not exists (select 1 from drivers x where x.user_id = users.id)`, [normPhone(b.phone)]) : null;
    if (usr) { await pool.query("update drivers set user_id = $2 where id = $1", [d.id, usr.id]); d.user_id = usr.id; }
    await audit(pool, u.id, "driver_create", "driver", d.id, { name: b.name });
    return reply.status(201).send({ driver: driverOut(d) });
  });

  app.patch("/drivers/:id", async (req) => {
    const u = await staff(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = DriverIn.partial().parse(req.body);
    const d = await one(pool, "select base from drivers where id = $1", [id]);
    if (!d) throw notFound("Водитель не найден");
    if (d.base !== myBase(u)) throw forbidden("Водитель не из вашей базы");
    await checkCompany(u, b.companyId);
    const s = setSql(b, DCOLS);
    if (!s.keys.length) throw bad("Нечего менять");
    const r = await one(pool, `update drivers set ${s.sql} where id = $1 returning *`, [id, ...s.vals]);
    await audit(pool, u.id, "driver_update", "driver", id, Object.keys(b));
    return { driver: driverOut(r) };
  });

  app.get("/companies", async (req) => {
    const u = await staff(req);
    return { companies: await many(pool, "select * from companies where base = $1 order by name", [myBase(u)]) };
  });

  app.post("/companies", async (req, reply) => {
    const u = await staff(req);
    const b = CompanyIn.parse(req.body);
    const s = setSql(b, CCOLS, 2);
    const c = await one(pool, `insert into companies(base, ${s.keys.map((k) => CCOLS[k]).join(", ")}) values ($1, ${s.keys.map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
      [myBase(u), ...s.vals]);
    await audit(pool, u.id, "company_create", "company", c.id, { name: b.name });
    return reply.status(201).send({ company: c });
  });

  app.patch("/companies/:id", async (req) => {
    const u = await staff(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = CompanyIn.partial().parse(req.body);
    const c = await one(pool, "select base from companies where id = $1", [id]);
    if (!c) throw notFound("Компания не найдена");
    if (c.base !== myBase(u)) throw forbidden("Компания не из вашей базы");
    const s = setSql(b, CCOLS);
    if (!s.keys.length) throw bad("Нечего менять");
    const r = await one(pool, `update companies set ${s.sql} where id = $1 returning *`, [id, ...s.vals]);
    await audit(pool, u.id, "company_update", "company", id, Object.keys(b));
    return { company: r };
  });
}
