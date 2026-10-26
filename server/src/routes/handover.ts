// передача машины: фото и видео, дефекты в акте, подписи сторон, история прошлых передач
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { many, one, tx } from "../db/pool.js";
import { bad, conflict, forbidden, notFound } from "../errors.js";
import { carFolder, extOf, mediaKey, stageFolder } from "../domain/files.js";
import { checkpointsOf, COND_KEYS, cpGate, DMG_CODES, hoVideos, photoSpec, STAGES, type Stage } from "../domain/stages.js";
import { requireUser, type AuthUser } from "../services/auth.js";
import { audit } from "../services/audit.js";
import { loadOrder, stageNum } from "../services/context.js";
import { actorOf, canView, loadStage, marksOf, missingOf, permsOf, resetSigs, stateOut, type StageState } from "../services/handover.js";

const P = z.object({ no: z.coerce.number().int(), stage: z.string() });
const CODES = DMG_CODES.map((c) => c[0]) as [string, ...string[]];
const STAFF = ["manager", "terminal", "driver"] as const;

export default async function (app: FastifyInstance) {
  const { pool, storage } = app.deps;
  const who = (req: FastifyRequest) => requireUser(pool, req, ...STAFF);

  const state = async (u: AuthUser, no: number, st: string) => {
    const s = await loadStage(pool, u, no, st);
    return stateOut(u, s, await marksOf(pool, no));
  };
  const assertOpen = (s: StageState) => {
    if (s.section.closed_at || s.stage.done_at) throw conflict("Этап уже закрыт подписями");
  };

  // цепочка передач машины
  app.get("/orders/:no/stages", async (req) => {
    const u = await who(req);
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const { row, ctx } = await loadOrder(pool, no);
    if (!canView(u, ctx)) throw forbidden("Машина не из вашей цепочки");
    const st = await many(pool, "select s.*, a.give_name, a.take_name, a.closed_at from stages s left join act_sections a using (order_no, stage) where s.order_no = $1", [no]);
    return {
      order: { no: row.no, car: row.car, vin: row.vin, city: row.city, transferCity: row.transfer_city },
      stages: checkpointsOf(ctx).map((c, i) => {
        const x = st.find((r) => r.stage === c.id);
        return { stage: c.id, num: i + 1, name: STAGES[c.id].name, place: x?.place ?? null, doneAt: x?.done_at ?? null, giveName: x?.give_name ?? null, takeName: x?.take_name ?? null };
      }),
    };
  });

  app.get("/orders/:no/stages/:stage", async (req) => {
    const u = await who(req);
    const p = P.parse(req.params);
    return state(u, p.no, p.stage);
  });

  /* --- фото и видео --- */
  app.post("/orders/:no/stages/:stage/media", async (req, reply) => {
    const u = await who(req);
    const p = P.parse(req.params);
    const file = await req.file();
    if (!file) throw bad("Нет файла");
    const f = z.object({ kind: z.enum(["photo", "video"]), slot: z.coerce.number().int().min(0).max(30) })
      .parse({ kind: (file.fields.kind as any)?.value, slot: (file.fields.slot as any)?.value });
    const s = await loadStage(pool, u, p.no, p.stage);
    assertOpen(s);
    const shot = f.kind === "photo" ? s.photos.find((x) => x.slot === f.slot) : null;
    const vid = f.kind === "video" ? hoVideos(s.st)[f.slot] && s.videos.find((x) => x.slot === f.slot) : null;
    if (!shot && !vid) throw bad("Такого снимка на этом этапе нет");
    const perms = permsOf(u, s), by = shot?.by ?? "driver";
    if (!(by === "terminal" ? perms.shootTerminal : perms.shootDriver))
      throw forbidden(s.st === "term_out" ? (by === "terminal" ? "Этот снимок делает приёмщик терминала" : "Этот снимок делает принимающий водитель") : "Снимает сторона, которая осматривает машину");
    if (f.kind === "photo" && !/^image\//.test(file.mimetype)) throw bad("Нужна фотография");
    if (f.kind === "video" && !/^video\//.test(file.mimetype)) throw bad("Нужен видеофайл");

    const first = !s.media.length;
    const started = first ? new Date() : new Date(s.stage.started_at);
    const base = `${carFolder(s.row, new Date(s.row.created_at).getFullYear())}/${stageFolder(stageNum(s.ctx, s.st), s.st, started, s.stage.place)}`;
    const title = shot ? shot.title : vid!.title;
    const key = mediaKey(base, f.kind, f.slot, title, extOf(file.mimetype, file.filename, f.kind === "photo" ? "jpg" : "mp4"), randomBytes(3).toString("hex"));
    const { size } = await storage.put(key, file.file);
    if (file.file.truncated) { await storage.remove(key); throw bad("Файл больше допустимого размера"); }
    const a = actorOf(u, s);
    const m = await tx(pool, async (c) => {
      if (first) await c.query("update stages set started_at = now() where order_no = $1 and stage = $2", [p.no, s.st]);
      await c.query("update media set replaced = true where order_no = $1 and stage = $2 and kind = $3 and slot = $4 and not replaced", [p.no, s.st, f.kind, f.slot]);
      const m = await one(c, `insert into media(order_no, stage, kind, slot, storage_key, mime, size, original_name, uploaded_by, uploaded_as)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [p.no, s.st, f.kind, f.slot, key, file.mimetype, size, file.filename, u.id, a.who]);
      if (await resetSigs(c, p.no, s.st)) await audit(c, u.id, "sigs_reset", "order", p.no, { stage: s.st, reason: "media" });
      await audit(c, u.id, "media_upload", "order", p.no, { stage: s.st, kind: f.kind, slot: f.slot, as: a.who });
      return m;
    });
    return reply.status(201).send({ id: m.id, key });
  });

  // файл отдаётся любому участнику цепочки машины и менеджеру
  app.get("/media/:id", async (req, reply) => {
    const u = await who(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const m = await one(pool, "select * from media where id = $1", [id]);
    if (!m) throw notFound("Файл не найден");
    const { ctx } = await loadOrder(pool, m.order_no);
    if (!canView(u, ctx)) throw forbidden("Машина не из вашей цепочки");
    reply.header("content-type", m.mime ?? "application/octet-stream");
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(await storage.get(m.storage_key));
  });

  /* --- дефекты в акте --- */
  app.post("/orders/:no/stages/:stage/marks", async (req, reply) => {
    const u = await who(req);
    const p = P.parse(req.params);
    const b = z.object({
      code: z.enum(CODES), x: z.number().min(0).max(1), y: z.number().min(0).max(1), part: z.string().max(120).default(""),
      src: z.enum(["manual", "ai"]).default("manual"), photoSlot: z.number().int().min(0).max(30).nullable().default(null),
    }).parse(req.body);
    const s = await loadStage(pool, u, p.no, p.stage);
    assertOpen(s);
    if (!permsOf(u, s).marks) throw forbidden(s.st === "term_out" ? "При отгрузке с терминала дефекты отмечает только принимающий водитель" : "Дефекты отмечает сторона, которая осматривает машину");
    const a = actorOf(u, s);
    const id = await tx(pool, async (c) => {
      const m = await one(c, "insert into defect_marks(order_no, code, part, x, y, first_stage) values ($1,$2,$3,$4,$5,$6) returning id", [p.no, b.code, b.part, b.x, b.y, s.st]);
      await c.query(`insert into mark_history(mark_id, stage, action, code, src, photo_slot, who, role, user_id) values ($1,$2,'add',$3,$4,$5,$6,$7,$8)`,
        [m.id, s.st, b.code, b.src, b.photoSlot, a.who, a.role, u.id]);
      await resetSigs(c, p.no, s.st);
      await audit(c, u.id, "mark_add", "order", p.no, { stage: s.st, mark: Number(m.id), code: b.code, as: a.who });
      return Number(m.id);
    });
    return reply.status(201).send({ id });
  });

  const markOf = async (no: number, id: number) => {
    const m = await one(pool, "select * from defect_marks where id = $1 and order_no = $2", [id, no]);
    if (!m) throw notFound("Отметка не найдена");
    return m;
  };

  app.patch("/orders/:no/stages/:stage/marks/:id", async (req) => {
    const u = await who(req);
    const p = P.extend({ id: z.coerce.number().int() }).parse(req.params);
    const { code } = z.object({ code: z.enum(CODES) }).parse(req.body);
    const s = await loadStage(pool, u, p.no, p.stage);
    assertOpen(s);
    if (!permsOf(u, s).marks) throw forbidden("Нет права менять отметки на этом этапе");
    const m = await markOf(p.no, p.id);
    if (m.removed) throw conflict("Отметка снята");
    if (m.code === code) return { ok: true };
    const a = actorOf(u, s);
    await tx(pool, async (c) => {
      await c.query("update defect_marks set code = $2 where id = $1", [p.id, code]);
      await c.query(`insert into mark_history(mark_id, stage, action, from_code, to_code, who, role, user_id) values ($1,$2,'refine',$3,$4,$5,$6,$7)`,
        [p.id, s.st, m.code, code, a.who, a.role, u.id]);
      await resetSigs(c, p.no, s.st);
      await audit(c, u.id, "mark_refine", "order", p.no, { stage: s.st, mark: p.id, from: m.code, to: code });
    });
    return { ok: true };
  });

  // снять свою ошибочную отметку можно до закрытия раздела, на том же этапе
  app.delete("/orders/:no/stages/:stage/marks/:id", async (req) => {
    const u = await who(req);
    const p = P.extend({ id: z.coerce.number().int() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3, "Укажите причину") }).parse(req.body);
    const s = await loadStage(pool, u, p.no, p.stage);
    assertOpen(s);
    const m = await markOf(p.no, p.id);
    const first = await one(pool, "select who, user_id from mark_history where mark_id = $1 and action = 'add'", [p.id]);
    const a = actorOf(u, s);
    if (m.removed || m.first_stage !== s.st || first?.user_id !== u.id || first?.who !== a.who) throw forbidden("Снять можно только свою отметку этого этапа");
    await tx(pool, async (c) => {
      await c.query("update defect_marks set removed = true where id = $1", [p.id]);
      await c.query(`insert into mark_history(mark_id, stage, action, reason, who, role, user_id) values ($1,$2,'remove',$3,$4,$5,$6)`, [p.id, s.st, reason, a.who, a.role, u.id]);
      await resetSigs(c, p.no, s.st);
      await audit(c, u.id, "mark_remove", "order", p.no, { stage: s.st, mark: p.id, reason });
    });
    return { ok: true };
  });

  // менеджер снимает отметку и после подписей — с обязательным комментарием, подписи не сбрасываются
  app.delete("/orders/:no/marks/:id", async (req) => {
    const u = await requireUser(pool, req, "manager");
    const p = z.object({ no: z.coerce.number().int(), id: z.coerce.number().int() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3, "Комментарий менеджера обязателен") }).parse(req.body);
    const m = await markOf(p.no, p.id);
    if (m.removed) throw conflict("Отметка уже снята");
    const last = await one(pool, "select stage from act_sections where order_no = $1 and closed_at is not null order by closed_at desc limit 1", [p.no]);
    await tx(pool, async (c) => {
      await c.query("update defect_marks set removed = true where id = $1", [p.id]);
      await c.query(`insert into mark_history(mark_id, stage, action, reason, by_manager, who, role, user_id) values ($1,$2,'remove',$3,true,$4,'Менеджер',$5)`,
        [p.id, last?.stage ?? m.first_stage, reason, u.name, u.id]);
      await audit(c, u.id, "mark_remove_manager", "order", p.no, { mark: p.id, reason });
    });
    return { ok: true };
  });

  /* --- раздел акта: стороны, условия осмотра, данные машины --- */
  app.patch("/orders/:no/stages/:stage/section", async (req) => {
    const u = await who(req);
    const p = P.parse(req.params);
    const b = z.object({
      giveName: z.string().trim().min(3), takeName: z.string().trim().min(3),
      cond: z.record(z.enum(COND_KEYS), z.boolean()), condOther: z.string().max(200), notes: z.string().max(2000),
      disagree: z.boolean(), disComment: z.string().max(500), absent: z.boolean(), absentReason: z.string().max(500),
      driverMode: z.boolean(),
      car: z.object({ plate: z.string().max(20), ptsType: z.string().max(40), ptsNo: z.string().max(40), keys: z.string().max(10), extraDocs: z.string().max(300) }).partial(),
    }).partial().parse(req.body);
    const s = await loadStage(pool, u, p.no, p.stage);
    assertOpen(s);
    const perms = permsOf(u, s);
    if (u.role === "manager" || !(perms.marks || perms.signGive || perms.signTake || perms.driverMode)) throw forbidden("Раздел заполняют участники передачи");
    if (b.driverMode !== undefined && !perms.driverMode) throw forbidden("Экран водителю передаёт приёмщик терминала");
    if ((b.disagree !== undefined || b.disComment !== undefined) && (s.section.give_sig || !perms.signGive)) throw forbidden("Несогласие отмечает сдающая сторона до своей подписи");
    if ((b.absent !== undefined || b.absentReason !== undefined) && (s.section.give_sig || !perms.signTake)) throw forbidden("Отсутствие сдающей стороны отмечает принимающая");
    if (b.car && s.st !== "priemka") throw bad("Данные машины заполняются при приёмке");
    const sets: string[] = [], vals: unknown[] = [p.no, s.st];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.giveName !== undefined) put("give_name", b.giveName);
    if (b.takeName !== undefined) put("take_name", b.takeName);
    if (b.giveName !== undefined || b.takeName !== undefined) sets.push("named = true");
    if (b.cond !== undefined) put("cond", JSON.stringify(b.cond));
    if (b.condOther !== undefined) put("cond_other", b.condOther);
    if (b.notes !== undefined) put("notes", b.notes);
    if (b.disagree !== undefined) put("disagree", b.disagree);
    if (b.disComment !== undefined) put("dis_comment", b.disComment);
    if (b.absent !== undefined) put("absent", b.absent);
    if (b.absentReason !== undefined) put("absent_reason", b.absentReason);
    if (b.driverMode !== undefined) put("driver_mode", b.driverMode);
    // переключение экрана и отметки сдающей стороны не меняют содержание акта
    const content = ["giveName", "takeName", "cond", "condOther", "notes", "car"].some((k) => (b as any)[k] !== undefined);
    await tx(pool, async (c) => {
      if (sets.length) await c.query(`update act_sections set ${sets.join(", ")} where order_no = $1 and stage = $2`, vals);
      if (b.car) {
        const cc = b.car, map = { plate: "plate", ptsType: "pts_type", ptsNo: "pts_no", keys: "keys_count", extraDocs: "extra_docs" } as const;
        const ks = (Object.keys(cc) as (keyof typeof map)[]).filter((k) => cc[k] !== undefined);
        if (ks.length) await c.query(`update orders set ${ks.map((k, i) => `${map[k]} = $${i + 2}`).join(", ")} where no = $1`, [p.no, ...ks.map((k) => cc[k])]);
      }
      if (content) await resetSigs(c, p.no, s.st);
      await audit(c, u.id, "section_update", "order", p.no, { stage: s.st, fields: Object.keys(b) });
    });
    return state(u, p.no, p.stage);
  });

  /* --- подписи: сначала «Сдал», затем «Принял» — она закрывает раздел и этап --- */
  app.post("/orders/:no/stages/:stage/sign", async (req) => {
    const u = await who(req);
    const p = P.parse(req.params);
    const b = z.object({ side: z.enum(["give", "take"]), image: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Подпись — изображение PNG").max(700_000) }).parse(req.body);
    const s = await loadStage(pool, u, p.no, p.stage);
    assertOpen(s);
    const perms = permsOf(u, s), sec = s.section;
    if (!(b.side === "give" ? perms.signGive : perms.signTake))
      throw forbidden(s.st === "term_out" ? (b.side === "give" ? "«Сдал» подписывает приёмщик терминала" : "«Принял» подписывает водитель") : "Подписывают участники передачи");
    const gate = cpGate(s.ctx, s.st, s.done);
    if (!gate.ok) throw conflict(gate.why);
    const miss = missingOf(s);
    if (miss.photos.length || miss.videos.length) throw conflict(`Сначала фото и видео этапа: не хватает фото ${miss.photos.length}, видео ${miss.videos.length}`);
    if (b.side === "give") {
      if (sec.give_sig) throw conflict("«Сдал» уже подписано");
      if (sec.disagree && !sec.dis_comment.trim()) throw bad("Укажите, с чем не согласна сдающая сторона");
    } else if (!sec.give_sig && !(sec.absent && sec.absent_reason.trim())) throw conflict(s.st === "term_out" ? "Ждёт подписи приёмщика «Сдал»" : "Сначала подпись сдающей стороны");

    const png = Buffer.from(b.image.split(",")[1], "base64");
    const base = `${carFolder(s.row, new Date(s.row.created_at).getFullYear())}/${stageFolder(stageNum(s.ctx, s.st), s.st, new Date(s.stage.started_at), s.stage.place)}`;
    const key = mediaKey(base, "signature", b.side === "give" ? 0 : 1, b.side === "give" ? "Сдал" : "Принял", "png", randomBytes(3).toString("hex"));
    await storage.put(key, png);
    return tx(pool, async (c) => {
      const m = await one(c, `insert into media(order_no, stage, kind, slot, storage_key, mime, size, uploaded_by, uploaded_as) values ($1,$2,'signature',$3,$4,'image/png',$5,$6,$7) returning id`,
        [p.no, s.st, b.side === "give" ? 0 : 1, key, png.length, u.id, b.side === "give" ? sec.give_name : sec.take_name]);
      const sig = { mediaId: m.id, at: new Date().toISOString(), deviceUser: u.id, deviceName: u.name };
      await c.query(`update act_sections set ${b.side}_sig = $3 where order_no = $1 and stage = $2`, [p.no, s.st, JSON.stringify(sig)]);
      await audit(c, u.id, "sign", "order", p.no, { stage: s.st, side: b.side });
      if (b.side === "take") await closeStage(c, s, u);
      return { closed: b.side === "take" };
    });
  });

  // раздел закрыт: этап завершён, за машину отвечает принявшая сторона
  async function closeStage(c: any, s: StageState, u: AuthUser) {
    await c.query("update act_sections set closed_at = now() where order_no = $1 and stage = $2", [s.row.no, s.st]);
    await c.query("update stages set done_at = now(), mode = $3 where order_no = $1 and stage = $2", [s.row.no, s.st, s.st === "term_out" ? JSON.stringify(s.mode) : null]);
    if (s.st === "vygruzka") await c.query("update orders set delivered_at = now() where no = $1", [s.row.no]);
    const leg = checkpointsOf(s.ctx).find((x) => x.id === s.st)!.leg, trip = s.ctx.legs[leg]?.trip;
    const sec = await one(c, "select give_name, take_name from act_sections where order_no = $1 and stage = $2", [s.row.no, s.st]);
    if (trip) await c.query("insert into trip_events(trip_id, city, note, public) values ($1,$2,$3,false)",
      [trip.id, s.stage.place, `${STAGES[s.st].name}: №${s.row.no} ${s.row.car} · сдал ${sec.give_name}, принял ${sec.take_name}`]);
    await audit(c, u.id, "stage_done", "order", s.row.no, { stage: s.st });
  }

  /* --- история машины: всё, что сняли и подписали на прошлых передачах --- */
  app.get("/orders/:no/history", async (req) => {
    const u = await who(req);
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const { ctx } = await loadOrder(pool, no);
    if (!canView(u, ctx)) throw forbidden("Машина не из вашей цепочки");
    const stages = await many(pool, "select * from stages where order_no = $1", [no]);
    const secs = await many(pool, "select * from act_sections where order_no = $1", [no]);
    const media = await many(pool, "select id, stage, kind, slot, mime, uploaded_as, created_at from media where order_no = $1 and not replaced order by created_at", [no]);
    const marks = await marksOf(pool, no);
    return {
      stages: checkpointsOf(ctx).filter((c) => stages.some((x) => x.stage === c.id)).map((c, i) => {
        const x = stages.find((r) => r.stage === c.id), sec = secs.find((r) => r.stage === c.id), spec = photoSpec(c.id as Stage), vids = hoVideos(c.id as Stage);
        return {
          stage: c.id, num: i + 1, name: STAGES[c.id].name, place: x.place, startedAt: x.started_at, doneAt: x.done_at,
          give: sec ? { role: sec.give_role, name: sec.give_name, signedAt: sec.give_sig?.at ?? null } : null,
          take: sec ? { role: sec.take_role, name: sec.take_name, signedAt: sec.take_sig?.at ?? null } : null,
          disagree: sec?.disagree ? sec.dis_comment : null, absent: sec?.absent ? sec.absent_reason : null, notes: sec?.notes ?? "",
          media: media.filter((m) => m.stage === c.id).map((m) => ({
            id: m.id, kind: m.kind, slot: m.slot, mime: m.mime, uploadedAs: m.uploaded_as, at: m.created_at,
            title: m.kind === "photo" ? spec.find((p) => p.slot === m.slot)?.title ?? null : m.kind === "video" ? vids[m.slot]?.[0] ?? null : m.slot === 0 ? "Сдал" : "Принял",
          })),
          defects: marks.flatMap((mk) => mk.history.filter((h) => h.stage === c.id).map((h) => ({ markId: mk.id, ...h }))),
        };
      }),
      marks,
    };
  });
}
