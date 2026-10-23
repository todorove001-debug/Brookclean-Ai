// PDF акта приёма-передачи по шаблону «Акт приема передачи.docx»: данные авто, схема кузова с отметками,
// журнал дефектов и подписи всех передач. pdfmake грузится только по нажатию кнопки.
import { CARRIER, CONDITIONS, DMG_CODES, STAGES, dateLong, type ActView, type DmgCode } from "@brookclean/shared";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { DEMO } from "../router.ts";
import diagramSrc from "../assets/car-diagram.jpg";
import logoSrc from "../assets/logo.jpg";

const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const i = new Image();
  i.onload = () => ok(i);
  i.onerror = fail;
  i.src = src;
});

/** Схема кузова с отметками этого и прошлых разделов — картинкой для PDF. */
async function diagramWithMarks(a: ActView): Promise<string> {
  const img = await loadImg(diagramSrc);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  for (const m of a.marks.filter((x) => !x.removed)) {
    const x = m.x * c.width, y = m.y * c.height;
    g.fillStyle = STAGES[m.stage].color;
    g.beginPath();
    g.arc(x, y, 17, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 14px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(m.code, x, y + 1);
  }
  return c.toDataURL("image/jpeg", 0.9);
}

async function asDataUrl(src: string) {
  const img = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.9);
}

const t = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Vladivostok" }) : "");
const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);
const line = (label: string, value: string): Content => ({ text: [label + ": ", { text: value || "—", bold: true }], margin: [0, 0, 0, 3] });

export async function actPdfDefinition(a: ActView): Promise<TDocumentDefinitions> {
  const [diagram, logo] = await Promise.all([diagramWithMarks(a), asDataUrl(logoSrc)]);
  const first = a.sections[0];
  const codes = Object.entries(DMG_CODES) as Array<[DmgCode, string]>;
  const half = Math.ceil(codes.length / 2);
  const upto = a.sections.findIndex((s) => s.stage === a.stage) + 1;

  const sigCell = (title: string, name: string, sig: { img: string; at: string } | null, extra = ""): Content => ({
    stack: [
      { text: title, fontSize: 8, color: "#555555" },
      sig ? { image: sig.img, width: 120, height: 40 } : { text: "\n\n", fontSize: 8 },
      { text: `${name || "____________________"}${sig ? ` · ${t(sig.at)}` : ""}`, fontSize: 8 },
      ...(extra ? [{ text: extra, fontSize: 8, color: "#9a5b00" } as Content] : []),
    ],
  });

  return {
    pageSize: "A4",
    pageMargins: [42, 36, 42, 40],
    info: { title: `Акт приёма-передачи к договору № ${a.no}`, author: CARRIER.fullName },
    defaultStyle: { font: "Roboto", fontSize: 9.5, lineHeight: 1.15 },
    footer: (page, pages) => ({
      columns: [{ text: `Акт приёма-передачи к договору № ${a.no} · сформирован в системе Brookclean`, fontSize: 7, color: "#666666" },
        { text: `${page} из ${pages}`, fontSize: 7, color: "#666666", alignment: "right" }],
      margin: [42, 14, 42, 0],
    }),
    content: [
      { columns: [
        { stack: [
          { text: "АКТ ПРИЁМА – ПЕРЕДАЧИ", bold: true, fontSize: 14 },
          { text: `к договору № ${a.no}`, margin: [0, 2, 0, 0] },
          { text: `г. Владивосток. ${dateLong(a.contractDate)}`, margin: [0, 2, 0, 0] },
        ] },
        { image: logo, width: 64, alignment: "right" },
      ] },
      { text: [
        "Мы, нижеподписавшиеся, представитель Заказчика ", { text: first.giveName || a.client, bold: true },
        ", с одной стороны, и представитель Перевозчика ", { text: first.takeName || "________________", bold: true },
        ", с другой стороны, составили настоящий АКТ о том, что Заказчик передал, а Перевозчик принял к перевозке легковой автомобиль:",
      ], alignment: "justify", margin: [0, 10, 0, 6] },
      { columns: [line("Марка", a.car.car), line("VIN", a.car.vin)] },
      { columns: [line("Год выпуска", a.car.year), line("Цвет", a.car.color), line("Гос. номер", a.details.plate)] },
      line("Проведена фото-видео съёмка а/м", a.media.length ? "да" : "нет"),
      line(`ПТС (${a.details.ptsType}) №`, a.details.ptsNo),
      line("Дополнительные документы", a.details.docs),
      line("Принял: ключ, шт.", a.details.keys),
      line("Внешний вид автомобиля", "согласно схеме и фото-отчёту"),
      { text: "Оценка состояния кузова", bold: true, margin: [0, 8, 0, 4] },
      { columns: [
        { image: diagram, width: 300 },
        { stack: [
          ...a.sections.slice(0, upto).map((s, i): Content => ({ text: `${i + 1} · ${STAGES[s.stage].name}`, color: STAGES[s.stage].color, bold: true, fontSize: 8 })),
          { table: { widths: [22, "*"], body: codes.slice(0, half).map(([k, v]) => [{ text: k, bold: true }, v]) },
            layout: "lightHorizontalLines", fontSize: 7.5, margin: [0, 6, 0, 0] },
          { table: { widths: [22, "*"], body: codes.slice(half).map(([k, v]) => [{ text: k, bold: true }, v]) }, layout: "lightHorizontalLines", fontSize: 7.5 },
        ], margin: [10, 0, 0, 0] },
      ] },
      { text: "Журнал дефектов", bold: true, margin: [0, 8, 0, 3] },
      a.marks.length ? {
        table: {
          widths: [28, "*", 110, 110],
          headerRows: 1,
          body: [
            ["Код", "Дефект и место", "Отмечен", "Изменения"].map((h) => ({ text: h, bold: true, fontSize: 8 })),
            ...a.marks.map((m) => {
              const f = m.history[0];
              const later = m.history.slice(1).map((h) => h.act === "refine" ? `${h.who}: ${h.from}→${h.to}` : h.act === "remove" ? `${h.who}${h.manager ? " (менеджер)" : ""}: снята — ${h.reason}` : "").filter(Boolean).join("; ");
              const color = m.removed ? "#888888" : "#111111";
              return [
                { text: m.code, bold: true, color: STAGES[m.stage].color },
                { text: `${DMG_CODES[m.code]}${m.part ? ", " + m.part : ""}${m.removed ? " — СНЯТА" : ""}`, color },
                { text: `${STAGES[m.stage].name}, ${f.who}${m.src === "ai" ? " (находка ИИ, подтверждена)" : ""}`, fontSize: 8, color },
                { text: later, fontSize: 8, color },
              ];
            }),
          ],
        },
        layout: "lightHorizontalLines", fontSize: 8.5,
      } : { text: "Дефектов не отмечено", color: "#555555" },
      { text: [
        "Условия осмотра: ",
        { text: a.cond.length ? a.cond.map((c) => (c === "other" ? `иное — ${a.condOther}` : CONDITIONS[c].toLowerCase())).join(", ") : "нормальные", bold: true },
      ], margin: [0, 8, 0, 2] },
      ...(a.cond.length ? [{ text: "При наличии отметки в условиях осмотра тщательный осмотр ЛКП (лакокрасочного покрытия) невозможен!", bold: true, fontSize: 8.5 } as Content] : []),
      line("Дополнительные сведения", a.notes),
      { text: "Передачи и подписи", bold: true, margin: [0, 10, 0, 4] },
      {
        table: {
          widths: [110, "*", "*"],
          body: a.sections.slice(0, upto).map((s, i) => [
            { stack: [{ text: `${i + 1}. ${STAGES[s.stage].name}`, bold: true, color: STAGES[s.stage].color }, { text: STAGES[s.stage].site ?? a.car.city, fontSize: 8 },
              { text: s.closedAt ? `закрыт ${t(s.closedAt)}` : "не закрыт", fontSize: 8, color: "#555555" }] },
            sigCell(`Сдал, ${lowerFirst(STAGES[s.stage].give)}`, s.giveName, s.give,
              s.stage === a.stage && a.disagree ? `Не согласен с отметками: ${a.disComment}` : s.stage === a.stage && a.absent ? `Не подписал: ${a.absentReason}` : ""),
            sigCell(`Принял, ${lowerFirst(STAGES[s.stage].take)}`, s.takeName, s.take),
          ]),
        },
        layout: { hLineColor: () => "#bbbbbb", vLineColor: () => "#bbbbbb", paddingTop: () => 4, paddingBottom: () => 4 },
        unbreakable: true,
      },
      { text: "Подписи поставлены пальцем на экране телефона приёмщика. Фото и видео осмотра хранятся в системе Brookclean.", fontSize: 7.5, color: "#666666", margin: [0, 6, 0, 0] },
    ],
  };
}

export async function downloadActPdf(a: ActView) {
  const [{ default: pdfMake }, fonts, def] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts"), actPdfDefinition(a)]);
  const f = fonts as unknown as { vfs?: Record<string, string>; pdfMake?: { vfs: Record<string, string> }; default?: Record<string, string> };
  const pdf = pdfMake.createPdf(def, undefined, undefined, f.pdfMake?.vfs ?? f.vfs ?? f.default);
  const filename = `akt-${a.no}-${a.stage}.pdf`;
  // Демо-страница открывается внутри claude.ai, где обычное скачивание запрещено: файл отдаёт сам просмотрщик
  const downloads = DEMO ? await (window as unknown as DemoHost).claude?.use("downloads") : null;
  if (!downloads) return pdf.download(filename);
  const data = await new Promise<Blob>((ok) => pdf.getBlob(ok));
  await downloads.save({ filename, data }).catch((e: { code?: string }) => {
    if (e?.code !== "declined") throw e;
  });
}

interface DemoHost {
  claude?: { use(name: "downloads"): Promise<{ save(r: { filename: string; data: Blob }): Promise<unknown> } | null> };
}
