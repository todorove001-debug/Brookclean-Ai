# Генерация PDF договора

Модуль собирает два PDF по данным заказа:

- **Договор перевозки № N** с Приложением № 1 (авто, VIN, маршрут, стоимость прописью) и отметкой о подписи простой электронной подписью;
- **Согласие на обработку персональных данных** отдельным документом.

Стоимость перевозки в договоре одна сумма: `тариф + кэшбэк партнёра`. Кэшбэк отдельной строкой нигде не выводится. Страховка считается как 0,3% от стоимости автомобиля.

## Запуск

```bash
npm install
npm run example          # out/dogovor-685.pdf и out/soglasie-pd-685.pdf из scripts/example-order.json
npm test
node scripts/generate.js заказ.json папка/
```

## Использование

На сервере (Node):

```js
const { renderContract, renderConsent } = require("./src/node");
const pdf = await renderContract(order); // Buffer
```

В браузере (тот же `src/contract.js`, шрифт Roboto с кириллицей из pdfmake):

```html
<script src="https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/pdfmake.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/vfs_fonts.js"></script>
<script src="contract.js"></script>
<script>
  pdfMake.createPdf(BrookcleanContract.buildContractDoc(order)).download("dogovor.pdf");
</script>
```

## Данные заказа

Пример: [`scripts/example-order.json`](scripts/example-order.json). Поле `signature` необязательно: без него в документе стоит «ожидает подписания». Если `signature.hash` не передан, Node-версия сама считает SHA-256 по данным договора (`fingerprintSource`).

## Что осталось

Разделы 1–5 договора и полный текст согласия пока заглушки в `TEMPLATE_SECTIONS` (`src/contract.js`). Их нужно заменить текстом из шаблона перевозчика, либо передать свои разделы: `buildContractDoc(order, { sections })`.
