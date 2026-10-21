// Рендер договора в PDF на сервере (Node). Шрифт Roboto с кириллицей берётся из pdfmake.
const crypto = require("crypto");
const PdfPrinter = require("pdfmake");
const vfs = require("pdfmake/build/vfs_fonts");
const contract = require("./contract");

const font = (name) => Buffer.from(vfs[name], "base64");
const printer = new PdfPrinter({
  Roboto: {
    normal: font("Roboto-Regular.ttf"),
    bold: font("Roboto-Medium.ttf"),
    italics: font("Roboto-Italic.ttf"),
    bolditalics: font("Roboto-MediumItalic.ttf"),
  },
});

function render(docDefinition) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function fingerprint(order) {
  return crypto.createHash("sha256").update(contract.fingerprintSource(order)).digest("hex");
}

// Если передан signature без hash, хэш данных договора считается здесь.
function withHash(order) {
  if (!order.signature || order.signature.hash) return order;
  return { ...order, signature: { ...order.signature, hash: fingerprint(order) } };
}

const renderContract = (order, opts) => render(contract.buildContractDoc(withHash(order), opts));
const renderConsent = (order) => render(contract.buildConsentDoc(withHash(order)));

module.exports = { renderContract, renderConsent, fingerprint, render };
