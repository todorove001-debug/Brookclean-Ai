// PDF договора в браузере: договор с Приложениями № 1–2 и согласие (Приложение № 3) одним файлом.
// pdfmake со шрифтом Roboto (кириллица) грузится только по нажатию кнопки.
import { consentDoc, contractDoc, dateShort, signLine, type Block, type ContractData } from "@brookclean/shared";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { DEMO } from "./router.ts";

export interface PdfSignature { phone: string; at: string; documentSha256: string }

function blockContent(b: Block): Content {
  switch (b.k) {
    case "title": return { text: b.text, bold: true, fontSize: 12, alignment: "center", margin: [0, 0, 0, 2] };
    case "center": return { text: b.text, alignment: "center", margin: [0, 0, 0, 6] };
    case "right": return { text: b.text, alignment: "right", fontSize: 9, margin: [0, 0, 0, 10] };
    case "row": return { columns: [b.left, { text: b.right, alignment: "right" }], margin: [0, 4, 0, 8] };
    case "h": return { text: b.text, bold: true, alignment: "center", margin: [0, 8, 0, 4] };
    case "p":
      return { text: b.runs.map((r) => (typeof r === "string" ? r : { text: r.b, bold: true })), alignment: "justify", margin: [0, 0, 0, 4], leadingIndent: 20 };
    case "break": return { text: "", pageBreak: "after" };
    case "table":
      return {
        table: { widths: [170, "*"], body: b.rows.map(([k, v], i) => [k, { text: v, bold: i === b.strong }]) },
        layout: { hLineColor: () => "#999999", vLineColor: () => "#999999", paddingTop: () => 3, paddingBottom: () => 3 },
        margin: [0, 0, 0, 10],
      };
    case "parties":
      return {
        columns: b.parties.map((p) => ({
          width: "*",
          stack: [{ text: p.title, bold: true }, ...p.lines, { text: "\n" + signLine(p.sign) }],
        })),
        columnGap: 20, fontSize: 9, margin: [0, 8, 0, 8], unbreakable: true,
      };
  }
}

function stamp(d: ContractData, s: PdfSignature): Content {
  return {
    table: {
      widths: ["*"],
      body: [[{
        color: "#2b5d8a", fontSize: 8,
        stack: [
          { text: "Подписано простой электронной подписью", bold: true, fontSize: 9 },
          `Заказчик: ${d.customer.fio}` + (d.company ? `, представитель ${d.company.name}` : ""),
          `Телефон: ${s.phone} · код из SMS подтверждён`,
          `Дата и время: ${new Date(s.at).toLocaleString("ru-RU", { timeZone: "Asia/Vladivostok" })} (Владивосток)`,
          `SHA-256 подписанных данных: ${s.documentSha256}`,
        ],
      }]],
    },
    layout: { hLineColor: () => "#2b5d8a", vLineColor: () => "#2b5d8a", paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 5, paddingBottom: () => 5 },
    margin: [0, 6, 0, 6],
    unbreakable: true,
  };
}

export function contractPdfDefinition(d: ContractData, signature?: PdfSignature): TDocumentDefinitions {
  const contract = contractDoc(d).blocks.map(blockContent);
  const consent = consentDoc(d).blocks.map(blockContent);
  if (signature) {
    // Отметка о подписи после реквизитов сторон (раздел 7) и в конце согласия
    const req = contractDoc(d).blocks.findIndex((b) => b.k === "parties");
    contract.splice(req + 1, 0, stamp(d, signature));
    consent.push(stamp(d, signature));
  }
  const name = d.no ? `Договор № ${d.no} от ${dateShort(d.date)}` : "Проект договора";
  return {
    pageSize: "A4",
    pageMargins: [56, 42, 42, 48],
    info: { title: name, author: "ИП Тодоров Е.К.", subject: "Договор перевозки груза автомобильным транспортом" },
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.15 },
    watermark: signature ? undefined : { text: "ПРОЕКТ", opacity: 0.07, bold: true },
    footer: (page, pages) => ({
      columns: [{ text: name, fontSize: 8, color: "#666666" }, { text: `${page} из ${pages}`, fontSize: 8, color: "#666666", alignment: "right" }],
      margin: [56, 16, 42, 0],
    }),
    content: [...contract, { text: "", pageBreak: "after" }, ...consent],
  };
}

export async function downloadContractPdf(d: ContractData, signature?: PdfSignature) {
  const [{ default: pdfMake }, fonts] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  // vfs_fonts в разных сборках отдаёт шрифты напрямую или внутри pdfMake.vfs
  const f = fonts as unknown as { vfs?: Record<string, string>; pdfMake?: { vfs: Record<string, string> }; default?: Record<string, string> };
  const vfs = f.pdfMake?.vfs ?? f.vfs ?? f.default;
  const pdf = pdfMake.createPdf(contractPdfDefinition(d, signature), undefined, undefined, vfs);
  const filename = d.no ? `dogovor-${d.no}.pdf` : "dogovor-proekt.pdf";
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
