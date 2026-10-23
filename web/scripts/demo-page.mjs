// Собирает dist-demo в одну HTML-страницу (стили и скрипт внутри): node web/scripts/demo-page.mjs out.html
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../dist-demo/assets/", import.meta.url).pathname;
const files = readdirSync(dir);
const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dir, f), "utf8"));
if (js.length !== 1) throw new Error("ожидался один JS-файл, есть: " + js.length);
// Символ U+FFFD внутри строк pdfmake пишем экранированным: страница не должна содержать «битых» символов
const html = `<title>Brookclean Автовоз</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=Unbounded:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js[0].replace(/<\/script/gi, "<\\/script").replace(/\uFFFD/g, "\\uFFFD")}</script>
`;
writeFileSync(process.argv[2], html);
console.log("ok", process.argv[2], Math.round(html.length / 1024) + " KB");
