/*
 * Договор перевозки и согласие на обработку ПД в формате pdfmake.
 * Файл без зависимостей: работает и в Node (require), и в браузере
 * (<script src>, тогда функции доступны как window.BrookcleanContract).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BrookcleanContract = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const INS_RATE = 0.003;

  const CARRIER = {
    name: "Индивидуальный предприниматель Тодоров Евгений Константинович",
    shortName: "ИП Тодоров Е.К.",
    signName: "Е.К. Тодоров",
    inn: "253717132973",
    phone: "+7 950 281 55 55",
  };

  const ORIGIN = "Уссурийск, ул. Штабского, г-ж 14Г, склад СВХ ООО «Логистический Терминал»";

  const BODY_NAMES = { sedan: "Седан / хэтчбек", cross: "Кроссовер", van: "Минивен / джип" };

  // Разделы 1–5 из шаблона перевозчика. Пока заглушки: замените текстом из шаблона.
  const TEMPLATE_SECTIONS = [
    { title: "1. Предмет договора", paragraphs: ["[Текст раздела 1 из шаблона договора]"] },
    { title: "2. Порядок перевозки", paragraphs: ["[Текст раздела 2 из шаблона договора]"] },
    { title: "3. Порядок расчётов", paragraphs: ["[Текст раздела 3 из шаблона договора]"] },
    { title: "4. Условия перевозки", paragraphs: ["[Текст раздела 4 из шаблона договора]"] },
    { title: "5. Ответственность сторон", paragraphs: ["[Текст раздела 5 из шаблона договора]"] },
  ];

  /* ===== Деньги и даты ===== */

  // Кэшбэк партнёра входит в стоимость перевозки и отдельно нигде не выводится.
  function calcPrice(order) {
    const delivery = Math.round(order.tariff) + Math.round(order.cashback || 0);
    const insurance = Math.round(order.value * INS_RATE);
    return { delivery, insurance, total: delivery + insurance };
  }

  function plural(n, forms) {
    const x = n % 100, y = n % 10;
    if (x > 10 && x < 20) return forms[2];
    return y === 1 ? forms[0] : y >= 2 && y <= 4 ? forms[1] : forms[2];
  }

  // Сумма прописью: 215000 → «двести пятнадцать тысяч»
  function words(n) {
    const o = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
    const of = ["", "одна", "две"].concat(o.slice(3));
    const te = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
    const tn = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
    const hu = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
    const scales = [null, [["тысяча", "тысячи", "тысяч"], true], [["миллион", "миллиона", "миллионов"], false], [["миллиард", "миллиарда", "миллиардов"], false]];
    if (!n) return "ноль";
    const parts = [];
    let i = 0;
    while (n > 0) {
      const t = n % 1000;
      if (t) {
        const w = [hu[Math.floor(t / 100)]];
        const d = t % 100;
        if (d >= 10 && d < 20) w.push(te[d - 10]);
        else {
          w.push(tn[Math.floor(d / 10)]);
          w.push((scales[i] && scales[i][1] ? of : o)[d % 10]);
        }
        if (i > 0) w.push(plural(t, scales[i][0]));
        parts.unshift(w.filter(Boolean).join(" "));
      }
      n = Math.floor(n / 1000);
      i++;
    }
    return parts.join(" ");
  }

  function groupDigits(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  // 215000 → «215 000 (двести пятнадцать тысяч) рублей 00 копеек»
  function rubWords(n) {
    n = Math.round(n);
    return groupDigits(n) + " (" + words(n) + ") " + plural(n, ["рубль", "рубля", "рублей"]) + " 00 копеек";
  }

  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  function toDate(d) {
    if (d instanceof Date) return d;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return new Date(d);
  }

  // «21» октября 2026 г.
  function dateLong(d) {
    d = toDate(d);
    return "«" + String(d.getDate()).padStart(2, "0") + "» " + MONTHS[d.getMonth()] + " " + d.getFullYear() + " г.";
  }

  // 21.10.2026
  function dateShort(d) {
    d = toDate(d);
    return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
  }

  /* ===== Проверка входных данных ===== */

  function validateOrder(order) {
    const errors = [];
    const need = (cond, msg) => { if (!cond) errors.push(msg); };
    const c = order.client || {}, p = c.passport || {};
    need(order.no, "нет номера договора");
    need(order.date, "нет даты договора");
    need(order.car, "нет марки и модели");
    need(order.vin, "нет VIN или номера кузова");
    need(order.city, "нет города доставки");
    need(Number.isFinite(order.tariff) && order.tariff > 0, "нет тарифа перевозки");
    need(Number.isFinite(order.value) && order.value > 0, "нет стоимости автомобиля");
    need(c.fio, "нет ФИО заказчика");
    need(c.phone, "нет телефона заказчика");
    need(p.series && p.number, "нет серии и номера паспорта");
    need(p.issuedBy && p.issuedDate, "нет сведений о выдаче паспорта");
    need(c.address, "нет адреса регистрации");
    if (errors.length) throw new Error("Договор не сформирован: " + errors.join(", "));
  }

  /* ===== Общие блоки ===== */

  const styles = {
    title: { fontSize: 13, bold: true, alignment: "center", margin: [0, 0, 0, 10] },
    h: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
    p: { margin: [0, 0, 0, 5], alignment: "justify" },
    small: { fontSize: 8, color: "#555555" },
    th: { bold: true },
    stamp: { fontSize: 9, color: "#2b5d8a" },
  };

  function baseDoc(meta, content) {
    return {
      pageSize: "A4",
      pageMargins: [56, 50, 42, 50],
      info: { title: meta.title, author: CARRIER.shortName, subject: meta.subject },
      defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.2 },
      styles,
      footer: (page, pages) => ({
        columns: [
          { text: meta.footer, style: "small" },
          { text: "Стр. " + page + " из " + pages, style: "small", alignment: "right" },
        ],
        margin: [56, 10, 42, 0],
      }),
      content,
    };
  }

  function signatureStamp(order) {
    const s = order.signature;
    if (!s) return { text: "Документ ожидает подписания заказчиком.", style: "small", margin: [0, 12, 0, 0] };
    return {
      margin: [0, 12, 0, 0],
      table: {
        widths: ["*"],
        body: [[{
          style: "stamp",
          stack: [
            { text: "Подписано простой электронной подписью", bold: true },
            "Заказчик: " + order.client.fio,
            "Телефон: " + (s.phone || order.client.phone) + " · код из SMS подтверждён",
            "Дата и время: " + s.at,
            s.hash ? "SHA-256 данных договора: " + s.hash : "",
          ].filter(Boolean),
        }]],
      },
      layout: {
        hLineColor: () => "#2b5d8a", vLineColor: () => "#2b5d8a",
        hLineWidth: () => 1.2, vLineWidth: () => 1.2,
        paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6,
      },
    };
  }

  function kvTable(rows) {
    return {
      table: {
        widths: [160, "*"],
        body: rows.map(([k, v, bold]) => [
          { text: k, color: "#444444", bold: !!bold },
          typeof v === "string" ? { text: v, bold: !!bold } : v,
        ]),
      },
      layout: {
        hLineColor: () => "#bbbbbb", vLineColor: () => "#bbbbbb",
        paddingLeft: () => 5, paddingRight: () => 5, paddingTop: () => 3, paddingBottom: () => 3,
      },
    };
  }

  /* ===== Договор с Приложением №1 ===== */

  function buildContractDoc(order, opts) {
    opts = opts || {};
    validateOrder(order);
    const price = calcPrice(order);
    const c = order.client, p = c.passport;
    const sections = opts.sections || TEMPLATE_SECTIONS;
    const body = BODY_NAMES[order.body];
    const car = order.car + " (" + [order.year, order.color].filter(Boolean).join(", ") + ")";

    const content = [
      { text: "Договор № " + order.no + "\nперевозки груза автомобильным транспортом", style: "title" },
      { columns: [{ text: "г. Владивосток" }, { text: dateLong(order.date), alignment: "right" }], margin: [0, 0, 0, 10] },
      {
        style: "p",
        text: [
          CARRIER.name + " (ИНН " + CARRIER.inn + "), именуемый далее «Перевозчик», с одной стороны, и гражданин ",
          { text: c.fio, bold: true },
          ", паспорт " + p.series + " " + p.number + ", именуемый далее «Заказчик», с другой стороны, заключили настоящий Договор о нижеследующем:",
        ],
      },
    ];

    sections.forEach((s) => {
      content.push({ text: s.title, style: "h" });
      s.paragraphs.forEach((t) => content.push({ text: t, style: "p" }));
    });

    content.push(
      { text: "6. Прочие условия", style: "h" },
      {
        style: "p",
        text: "6.8. Стороны признают простой электронной подписью Заказчика код подтверждения, направленный в SMS на номер " + c.phone +
          ". Документ, подписанный таким кодом, равнозначен документу на бумажном носителе, подписанному собственноручной подписью (ст. 6, 9 Федерального закона № 63-ФЗ «Об электронной подписи»).",
      },
      { text: "7. Реквизиты и подписи сторон", style: "h" },
      {
        columns: [
          {
            width: "*",
            stack: [
              { text: "Перевозчик", bold: true },
              CARRIER.name,
              "ИНН " + CARRIER.inn,
              "Тел.: " + CARRIER.phone,
              { text: "\n_______________ / " + CARRIER.signName + " /" },
            ],
          },
          {
            width: "*",
            stack: [
              { text: "Заказчик", bold: true },
              c.fio,
              "Паспорт " + p.series + " " + p.number,
              "выдан " + p.issuedBy + ", " + dateShort(p.issuedDate),
              "Адрес регистрации: " + c.address,
              "Тел.: " + c.phone,
            ],
          },
        ],
        columnGap: 20,
      },
      signatureStamp(order),

      { text: "Приложение № 1\nк Договору № " + order.no + " от " + dateShort(order.date), style: "title", pageBreak: "before" },
      { text: "Информация о грузе и условиях доставки", bold: true, alignment: "center", margin: [0, 0, 0, 10] },
      kvTable([
        ["Марка, модель", car],
        ["VIN (№ рамы, кузова)", String(order.vin).toUpperCase()],
        ["Тип кузова", body || "—"],
        ["Стоимость автомобиля (страховая сумма)", rubWords(order.value)],
        ["Пункт отправления", ORIGIN],
        ["Пункт назначения", order.city + (order.destAddress ? ", " + order.destAddress : " — адрес терминала выдачи")],
        ["Сроки доставки", "10–60 дней с момента выхода автомобиля на маршрут из Владивостока"],
        ["Стоимость перевозки", rubWords(price.delivery)],
        ["Страхование груза (0,3% от стоимости автомобиля)", rubWords(price.insurance)],
        ["Итого к оплате", rubWords(price.total), true],
        ["Порядок оплаты", "100% в течение 3 (трёх) дней с момента подписания Договора"],
      ]),
      signatureStamp(order)
    );

    return baseDoc(
      { title: "Договор № " + order.no, subject: "Договор перевозки " + order.car, footer: "Договор № " + order.no + " от " + dateShort(order.date) },
      content
    );
  }

  /* ===== Согласие на обработку персональных данных ===== */

  function buildConsentDoc(order) {
    validateOrder(order);
    const c = order.client, p = c.passport;
    const content = [
      { text: "Согласие на обработку персональных данных", style: "title" },
      { columns: [{ text: "г. Владивосток" }, { text: dateLong(order.date), alignment: "right" }], margin: [0, 0, 0, 10] },
      {
        style: "p",
        text: [
          "Я, ", { text: c.fio, bold: true },
          ", паспорт " + p.series + " " + p.number + ", выдан " + p.issuedBy + " " + dateShort(p.issuedDate) +
          ", зарегистрированный по адресу: " + c.address +
          ", действуя свободно, своей волей и в своём интересе, в соответствии с Федеральным законом № 152-ФЗ «О персональных данных» даю согласие " +
          CARRIER.name + " (ИНН " + CARRIER.inn + ") на обработку моих персональных данных: фамилия, имя, отчество, паспортные данные, номер телефона, адрес регистрации, сведения о транспортном средстве.",
        ],
      },
      {
        style: "p",
        text: "Цели обработки: заключение и исполнение договора перевозки № " + order.no +
          ", организация транспортировки, связь со мной, оформление документов. Передача данных водителям, логистическим и страховым компаниям допускается только для исполнения договора.",
      },
      { text: "[Остальной текст согласия из Приложения № 3 шаблона]", style: "p" },
      signatureStamp(order),
    ];
    return baseDoc(
      { title: "Согласие на обработку ПД · " + order.no, subject: "Согласие на обработку персональных данных", footer: "Согласие к Договору № " + order.no },
      content
    );
  }

  // Канонические данные договора, по которым считается SHA-256 для отметки о подписи.
  function fingerprintSource(order) {
    const price = calcPrice(order);
    const c = order.client;
    return JSON.stringify({
      no: order.no, date: dateShort(order.date), car: order.car, vin: String(order.vin).toUpperCase(), year: order.year,
      color: order.color, body: order.body, city: order.city, value: order.value,
      delivery: price.delivery, insurance: price.insurance, total: price.total,
      fio: c.fio, phone: c.phone, passport: c.passport, address: c.address,
    });
  }

  return {
    INS_RATE, CARRIER, ORIGIN, TEMPLATE_SECTIONS,
    calcPrice, words, rubWords, dateLong, dateShort, validateOrder,
    buildContractDoc, buildConsentDoc, fingerprintSource,
  };
});
