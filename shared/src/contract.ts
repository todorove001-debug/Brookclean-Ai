// Договор перевозки по шаблону перевозчика с подставленными данными клиента.
// Один источник текста для сайта (просмотр перед подписью), PDF и хеша подписи на сервере.
import { CARRIER, ORIGIN } from "./tariffs.ts";
import { parseRub, type CarForm, type CompanyForm, type CustomerForm } from "./order.ts";
import { rubWords, type Quote } from "./quote.ts";
import { CONTRACT_SECTIONS } from "./contract-text.ts";

/** Версия шаблона договора: меняется при каждой правке текста договора. */
export const CONTRACT_VERSION = "2026-10-23";

/** Всё, что подставляется в договор. Именно эти данные клиент подписывает кодом из SMS. */
export interface ContractData {
  /** null — номер ещё не присвоен (просмотр до отправки кода). */
  no: number | null;
  /** Дата договора YYYY-MM-DD по Владивостоку, null — до отправки кода. */
  date: string | null;
  customer: CustomerForm;
  /** Партнёр: Заказчик — компания из карточки партнёра, клиент подписывает как её представитель. */
  company: CompanyForm | null;
  car: { car: string; vin: string; year: string; color: string; value: number; city: string };
  price: { delivery: number; insurance: number; total: number };
}

export function contractData(
  no: number | null, date: string | null, car: CarForm, customer: CustomerForm, q: Quote, company: CompanyForm | null = null,
): ContractData {
  const t = (s: string) => s.trim();
  return {
    no, date,
    customer: {
      fio: t(customer.fio).replace(/\s+/g, " "), phone: customer.phone, passportSeries: customer.passportSeries,
      passportNumber: customer.passportNumber, passportIssued: t(customer.passportIssued), passportDate: customer.passportDate,
      address: t(customer.address),
    },
    company: company ? (Object.fromEntries(Object.entries(company).map(([k, v]) => [k, t(String(v))])) as unknown as CompanyForm) : null,
    car: { car: t(car.car), vin: t(car.vin).toUpperCase(), year: t(car.year), color: t(car.color), value: parseRub(car.value), city: car.city },
    price: { delivery: q.delivery, insurance: q.insurance, total: q.total },
  };
}

/* ===== Модель документа: её рисуют и страница сайта, и PDF ===== */

export type Run = string | { b: string };
export type Block =
  | { k: "title"; text: string }
  | { k: "center"; text: string }
  | { k: "right"; text: string }
  | { k: "row"; left: string; right: string }
  | { k: "h"; text: string }
  | { k: "p"; runs: Run[] }
  | { k: "table"; rows: Array<[string, string]>; strong?: number }
  | { k: "parties"; parties: Array<{ title: string; lines: string[]; sign: string }> }
  | { k: "break" };

export interface ContractDoc {
  title: string;
  blocks: Block[];
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const ymd = (d: string) => /^(\d{4})-(\d{2})-(\d{2})/.exec(d);

/** 2026-10-23 → «23» октября 2026 г. */
export function dateLong(d: string | null): string {
  const m = d ? ymd(d) : null;
  return m ? `«${m[3]}» ${MONTHS[+m[2] - 1]} ${m[1]} г.` : "«___» __________ 20__ г.";
}

/** 2026-10-23 → 23.10.2026 */
export function dateShort(d: string | null): string {
  const m = d ? ymd(d) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "__.__.____";
}

/** Сегодняшняя дата договора по Владивостоку: YYYY-MM-DD. */
export const contractDate = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "Asia/Vladivostok" });

/** «Иванов Пётр Сергеевич» → «Иванов П.С.» */
export function fioShort(fio: string): string {
  const [last, ...rest] = fio.trim().split(/\s+/);
  return [last, rest.map((w) => w[0]?.toUpperCase() + ".").join("")].filter(Boolean).join(" ");
}

const numText = (no: number | null) => (no ? `№ ${no}` : "№ ____");
const P = (...runs: Run[]): Block => ({ k: "p", runs });
const isIp = (c: CompanyForm) => c.inn.replace(/\D/g, "").length === 12;

function customerParty(d: ContractData) {
  const c = d.customer;
  const passport = [
    `Паспорт серия ${c.passportSeries} № ${c.passportNumber}`,
    `Выдан ${c.passportIssued}, ${dateShort(c.passportDate)}`,
    `Адрес регистрации: ${c.address}`,
  ];
  if (!d.company) return { title: "Заказчик:", lines: [c.fio, ...passport, `Тел.: ${c.phone}`], sign: fioShort(c.fio) };
  const co = d.company;
  return {
    title: "Заказчик:",
    lines: [
      co.name,
      `ИНН: ${co.inn}` + (co.kpp ? `, КПП: ${co.kpp}` : ""),
      `${isIp(co) ? "ОГРНИП" : "ОГРН"}: ${co.ogrn}`,
      `Адрес: ${co.address}`,
      `Р/счёт ${co.account}`,
      `Банк ${co.bank}`,
      `БИК ${co.bik}`,
      `К/счёт ${co.corrAccount}`,
      `Тел.: ${c.phone}` + (co.email ? `, e-mail: ${co.email}` : ""),
      `Представитель: ${c.fio}`,
      ...passport,
    ],
    sign: fioShort(c.fio),
  };
}

const carrierParty = (title: string) => ({
  title,
  lines: [
    CARRIER.fullName, `ИНН: ${CARRIER.inn}`, `Адрес: ${CARRIER.address}`, `ОГРНИП: ${CARRIER.ogrnip}`, `Р/счёт ${CARRIER.account}`,
    `Банк ${CARRIER.bank}`, `БИК ${CARRIER.bik}`, `К/счёт ${CARRIER.corrAccount}`, `Тел.: ${CARRIER.phone}`,
  ],
  sign: "Тодоров Е.К.",
});

const appendixHead = (n: number, d: ContractData): Block =>
  ({ k: "right", text: `Приложение № ${n}\nк Договору перевозки груза\nавтомобильным транспортом\n${numText(d.no)} от ${dateLong(d.date)}` });

/** Договор с Приложениями № 1 и № 2. */
export function contractDoc(d: ContractData): ContractDoc {
  const c = d.customer;
  const co = d.company;
  const shortSigns = { k: "parties", parties: [
    { title: "Исполнитель:", lines: [], sign: "Тодоров Е.К." },
    { title: "Заказчик:", lines: co ? [co.name] : [], sign: fioShort(c.fio) },
  ] } as const satisfies Block;

  const preamble: Run[] = co
    ? [`${CARRIER.fullName} (ИНН ${CARRIER.inn}), именуемый далее «Перевозчик», с одной стороны и `, { b: co.name },
      ` (ИНН ${co.inn}, ${isIp(co) ? "ОГРНИП" : "ОГРН"} ${co.ogrn}), в лице представителя `, { b: c.fio },
      `, именуемое далее «Заказчик», с другой стороны, заключили настоящий Договор о нижеследующем:`]
    : [`${CARRIER.fullName} (ИНН ${CARRIER.inn}), именуемый далее «Перевозчик», с одной стороны и гражданин `, { b: c.fio },
      `, именуемый далее «Заказчик», с другой стороны, заключили настоящий Договор о нижеследующем:`];

  const blocks: Block[] = [
    { k: "title", text: `Договор ${numText(d.no)}` },
    { k: "center", text: "перевозки груза автомобильным транспортом" },
    { k: "row", left: "г. Владивосток", right: dateLong(d.date) },
    P(...preamble),
  ];
  for (const s of CONTRACT_SECTIONS) {
    blocks.push({ k: "h", text: s.title });
    for (const t of s.paragraphs) blocks.push(P(t));
  }
  blocks.push(
    { k: "h", text: "6. ПРОЧИЕ УСЛОВИЯ" },
    P("6.1. Все споры и разногласия Стороны решают путем переговоров. В случае недостижения согласия, споры подлежат рассмотрению в Суде в соответствии с законодательством. Соблюдение претензионного порядка обязательно, срок рассмотрения претензий со стороны Перевозчика составляет 30 календарных дней."),
    P("6.2. По всем вопросам, не урегулированным положениями Договора, Стороны руководствуются законодательством Российской Федерации."),
    P("6.3. Настоящий Договор составлен в 2 (двух) экземплярах по одному для каждой из сторон."),
    P("6.4. Договор вступает в силу с момента его подписания и действует до момента исполнения Сторонами своих обязательств. Настоящий Договор составлен в 2 (двух) экземплярах по одному для каждой из сторон."),
    P("6.5. Неотъемлемой частью настоящего Договора являются:"),
    P("Приложение № 1 «Информация о грузе и условиях доставки»;"),
    P("Приложение № 2 «Акт приема-передачи»;"),
    P("Приложение № 3 «Согласие на обработку персональных данных»."),
    P("6.6. Стороны в том числе, признают юридическую силу Договора, Актов приема — передачи, Актов оказанных услуг, счетов/счетов-фактур, транспортных накладных, УПД, соглашений об изменении условий перевозки, подписываемых на бумажном носителе или с использованием факсимильного воспроизведения подписи и передаваемых Сторонами друг другу по электронной почте, указанной в Договоре, по телефонам, указанным в договоре, в том числе с использованием иных средств электронной коммуникации (интернет-мессенджеры, привязанные к указанным телефонам), позволяющих идентифицировать Сторону Договора, в виде электронного образа документа (сканированная копия, фото и т.п.), а также факт получения ею информации/документов."),
    P("Номера телефонов для обмена данными/документами между Сторонами Договора посредством СМС и электронных сообщений в мессенджерах:"),
    P(`Перевозчик: ${CARRIER.phone}`),
    P("Заказчик: ", { b: c.phone }),
    P("6.7. После подписания Договора вся предыдущая переписка Сторон утрачивает силу."),
    P(`6.8. Стороны признают простой электронной подписью Заказчика код подтверждения, направленный в SMS на номер ${c.phone}. Документ, подписанный таким кодом, равнозначен документу на бумажном носителе, подписанному собственноручной подписью (ст. 6, 9 Федерального закона № 63-ФЗ «Об электронной подписи»).`),
    { k: "h", text: "7. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН" },
    { k: "parties", parties: [carrierParty("Исполнитель:"), customerParty(d)] },

    { k: "break" },
    appendixHead(1, d),
    { k: "title", text: "Информация о грузе и условиях доставки" },
    {
      k: "table",
      rows: [
        ["Марка, Модель", d.car.car],
        ["VIN (№ рамы, кузова)", d.car.vin],
        ["Цвет", d.car.color],
        ["Год изготовления", d.car.year],
        ["Пункт отправления", ORIGIN],
        ["Пункт назначения", `${d.car.city}, терминал выдачи`],
        ["Сроки доставки", "Срок доставки: 10-60 дней, с момента выхода автомобиля на маршрут из Владивостока"],
        ["Стоимость перевозки", `${rubWords(d.price.delivery)} 00 копеек`],
        ["Заявленная стоимость груза", `${rubWords(d.car.value)} 00 копеек`],
        ["Страховка, 0.3% от заявленной стоимости груза", `${rubWords(d.price.insurance)} 00 копеек`],
        ["Итого к оплате", `${rubWords(d.price.total)} 00 копеек`],
      ],
      strong: 10,
    },
    shortSigns,

    { k: "break" },
    { k: "right", text: "Приложение № 2" },
    { k: "title", text: "АКТ ПРИЕМА – ПЕРЕДАЧИ" },
    { k: "center", text: `к договору - заявке ${numText(d.no)}` },
    { k: "row", left: "г. Владивосток", right: "«___» __________ 20__ г." },
    P("Мы, нижеподписавшиеся, представитель Заказчика ", { b: c.fio }, ", с одной стороны, и представитель Перевозчика ________________________________, с другой стороны, составили настоящий АКТ о том, что Заказчик передал, а Перевозчик принял к перевозке легковой автомобиль:"),
    P("Марка: ", { b: d.car.car }, ", VIN: ", { b: d.car.vin }, ","),
    P("Год выпуска: ", { b: d.car.year }, ", Цвет: ", { b: d.car.color }, ", Гос. Номер: ______________________"),
    P("Проведена фото-видео съемка а/м: да / нет"),
    P("ПТС (Оригинал, Выписка, Зав-ная копия) № ______________________________"),
    P("Дополнительные документы ___________________________________________"),
    P("Принял: Ключ ___ шт."),
    P("Внешний вид автомобиля: Согласно схемы и фото-отчета"),
    { k: "center", text: "Оценка состояния кузова" },
    {
      k: "table",
      rows: [
        ["A1", "Мелкая царапина"], ["A2", "Средняя царапина (с ладонь)"], ["A3", "Большая/глубокая царапина"],
        ["B1", "Мелкая вмятина"], ["B2", "Средняя вмятина (с ладонь)"], ["B3", "Большая/глубокая вмятина"],
        ["S", "Скол"], ["SS", "Множественные сколы"],
        ["W1", "Небольшой кузовной ремонт в хорошем состоянии"], ["W2", "Элемент с кузовным ремонтом (заметно на расстоянии)"],
        ["W3", "Требуется ремонт"], ["X", "Требуется замена детали"],
      ],
    },
    P("Дополнительные сведения: ___________________________________________"),
    P("Условия осмотра: Дождь / Снег / Темное время суток / Иное ____________"),
    P("При наличии отметки, в выше указанной таблице тщательный осмотр ЛКП (Лакокрасочное покрытие, а/м) не возможен!!!"),
    { k: "parties", parties: [
      { title: "Сдал, представитель Заказчика", lines: [], sign: fioShort(c.fio) },
      { title: "Принял, представитель Перевозчика", lines: [], sign: "" },
    ] },
    { k: "parties", parties: [
      { title: "Сдал, представитель Перевозчика", lines: [], sign: "" },
      { title: "Грузополучатель: Автомобиль принял, полноту, и стоимость выполненных работ подтверждаю, претензий не имею:", lines: [], sign: "" },
    ] },
  );
  return { title: `Договор перевозки ${numText(d.no)}`, blocks };
}

/** Приложение № 3: согласие на обработку ПД — отдельный документ (152-ФЗ). */
export function consentDoc(d: ContractData): ContractDoc {
  const c = d.customer;
  const blocks: Block[] = [
    appendixHead(3, d),
    { k: "title", text: "СОГЛАСИЕ\nна обработку персональных данных" },
    P("Я, ", { b: c.fio }, ","),
    P(`паспорт: серия ${c.passportSeries} № ${c.passportNumber}, выдан ${c.passportIssued},`),
    P(`дата выдачи: ${dateLong(c.passportDate)},`),
    P(`зарегистрированный(ая) по адресу: ${c.address},`),
    P(`действуя свободно, своей волей и в своём интересе, в соответствии с Федеральным законом РФ № 152-ФЗ «О персональных данных», настоящим даю согласие перевозчику: ${CARRIER.fullName} (ИНН ${CARRIER.inn}), (далее — Оператор), на обработку моих персональных данных на следующих условиях:`),
    { k: "h", text: "1. Перечень персональных данных:" },
    P("- фамилия, имя, отчество;"),
    P("- паспортные данные;"),
    P("- контактный номер телефона;"),
    P("- адрес электронной почты (при наличии);"),
    P("- адрес регистрации и фактического проживания;"),
    P("- сведения о транспортном средстве (марка, модель, VIN, цвет, год выпуска);"),
    P("- иные данные, предоставленные мной в связи с оказанием услуг по перевозке автомобиля."),
    { k: "h", text: "2. Цели обработки персональных данных:" },
    P("- заключение и исполнение договора перевозки автомобиля автовозом;"),
    P("- организация транспортировки транспортного средства;"),
    P("- связь со мной по вопросам оказания услуг;"),
    P("- оформление сопроводительных и бухгалтерских документов;"),
    { k: "h", text: "3. Действия с персональными данными:" },
    P("сбор, запись, систематизация, накопление, хранение, уточнение (обновление, изменение), использование, передача (в том числе третьим лицам — водителям, логистическим компаниям, страховым организациям), удаление."),
    { k: "h", text: "4. Передача третьим лицам:" },
    P("Я согласен(на), что мои персональные данные могут быть переданы третьим лицам исключительно в целях исполнения Договора перевозки."),
    { k: "h", text: "5. Срок обработки персональных данных:" },
    P("Настоящее согласие действует, с момента его подписания бессрочно, в рамках исполнения Договора перевозки."),
    { k: "h", text: "6. Отзыв согласия:" },
    P("Согласие может быть отозвано в любое время путём направления письменного уведомления Оператору."),
    { k: "h", text: "7. Подтверждение:" },
    P("Я подтверждаю, что ознакомлен(а) с условиями обработки моих персональных данных и предоставленные мной данные являются достоверными."),
    { k: "parties", parties: [{ title: "Подпись:", lines: [`Дата: ${dateLong(d.date)}`], sign: fioShort(c.fio) }] },
  ];
  return { title: `Согласие на обработку персональных данных ${numText(d.no)}`, blocks };
}

/** Строка подписи: «____________/Иванов П.С./» или пустая строка для ФИО от руки. */
export const signLine = (sign: string) => (sign ? `____________/${sign}/` : "____________ (ФИО, подпись)");

const runText = (r: Run) => (typeof r === "string" ? r : r.b);

/** Текст документа без оформления: по нему считается хеш подписи. */
export function docText(doc: ContractDoc): string {
  return doc.blocks.map((b) => {
    switch (b.k) {
      case "p": return b.runs.map(runText).join("");
      case "row": return `${b.left}\t${b.right}`;
      case "table": return b.rows.map((r) => r.join("\t")).join("\n");
      case "parties": return b.parties.map((p) => [p.title, ...p.lines, signLine(p.sign)].join("\n")).join("\n\n");
      case "break": return "\f";
      default: return b.text;
    }
  }).join("\n");
}
