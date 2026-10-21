// node scripts/generate.js [order.json] [папка] — пишет договор и согласие в PDF.
const fs = require("fs");
const path = require("path");
const { renderContract, renderConsent } = require("../src/node");

(async () => {
  const input = process.argv[2] || path.join(__dirname, "example-order.json");
  const outDir = process.argv[3] || path.join(__dirname, "..", "out");
  const order = JSON.parse(fs.readFileSync(input, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });
  const files = [
    ["dogovor-" + order.no + ".pdf", await renderContract(order)],
    ["soglasie-pd-" + order.no + ".pdf", await renderConsent(order)],
  ];
  for (const [name, buf] of files) {
    fs.writeFileSync(path.join(outDir, name), buf);
    console.log(path.join(outDir, name), buf.length + " байт");
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
