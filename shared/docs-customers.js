// Business cutoff requested on 19 November 2026, midnight Moscow. Never slides on restart.
export const DOCS_CUSTOMERS_SINCE = "2026-11-18T21:00:00.000Z";
export const DOCS_COMPANY_FIELDS = [
  { name: "companyName", label: "Название компании", max: 300 },
  { name: "inn", label: "ИНН", max: 12 },
  {
    name: "headPosition",
    label: "Должность руководителя организации",
    max: 200,
  },
  { name: "headFullName", label: "ФИО руководителя организации", max: 200 },
  {
    name: "occupationalSafetyPosition",
    label: "Должность ответственного по охране труда",
    max: 200,
  },
  {
    name: "occupationalSafetyFullName",
    label: "ФИО ответственного по охране труда",
    max: 200,
  },
];
export const DOCS_CALL_OUTCOMES = {
  reached: "Связались",
  no_answer: "Не дозвонились",
  callback: "Перезвонить",
};
const bad = () =>
  Object.assign(new Error("Проверьте данные клиента BoykovDocs."), {
    status: 400,
  });
export function customerText(value, max, required = false) {
  if (value === undefined || value === null) {
    if (required) throw bad();
    return "";
  }
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
    throw bad();
  const result = value.trim();
  if (required && !result) throw bad();
  return result;
}
export function customerDate(
  value,
  { nullable = false, now = Date.now() } = {},
) {
  if (nullable && (value === null || value === undefined || value === ""))
    return null;
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw bad();
  const ms = Date.parse(value);
  if (ms > now + 300000) throw bad();
  return new Date(ms).toISOString();
}
export function normalizeDocsCustomerEvent(input, now = Date.now()) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !["registration", "company"].includes(input.kind)
  )
    throw bad();
  const eventId = customerText(input.eventId, 160, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(eventId)) throw bad();
  const occurredAt = customerDate(input.occurredAt, { now }),
    observedAt = customerDate(input.observedAt, { now });
  const u = input.user;
  if (!u || typeof u !== "object" || Array.isArray(u)) throw bad();
  const id = customerText(u.id, 160, true);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw bad();
  const user = {
    id,
    name: customerText(u.name, 200),
    email: customerText(u.email, 254),
    phone: customerText(u.phone, 80),
    registeredAt: customerDate(u.registeredAt, {
      nullable: input.kind === "company",
      now,
    }),
  };
  if (user.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw bad();
  if (input.kind === "registration" && user.registeredAt !== occurredAt)
    throw bad();
  let company = null;
  if (input.kind === "company") {
    if (
      !input.company ||
      typeof input.company !== "object" ||
      Array.isArray(input.company)
    )
      throw bad();
    company = {
      savedAt: customerDate(input.company.savedAt, { now }),
      ...Object.fromEntries(
        DOCS_COMPANY_FIELDS.map((f) => [
          f.name,
          customerText(input.company[f.name], f.max),
        ]),
      ),
    };
    if (
      company.savedAt !== occurredAt ||
      (company.inn && !/^(\d{10}|\d{12})$/.test(company.inn))
    )
      throw bad();
  }
  return { eventId, kind: input.kind, occurredAt, observedAt, user, company };
}

export function customerCallNote(value) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw bad();
  return value.replace(/\r\n?/g, "\n").trim();
}
