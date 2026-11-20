import { customerDate, customerText } from "./docs-customers.js";
const invalid = () =>
  Object.assign(new Error("Проверьте данные покупки BoykovDocs."), {
    status: 400,
  });
export function normalizeDocsSale(input, now = Date.now()) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.protocol !== 1
  )
    throw invalid();
  const eventId = customerText(input.eventId, 160, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(eventId)) throw invalid();
  const u = input.user,
    p = input.purchase;
  if (!u || !p || Array.isArray(u) || Array.isArray(p)) throw invalid();
  const id = customerText(u.id, 160, true);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || p.userId !== id) throw invalid();
  const user = {
    id,
    name: customerText(u.name, 200),
    phone: customerText(u.phone, 80),
    email: customerText(u.email, 254),
    registeredAt: customerDate(u.registeredAt, { nullable: true, now }),
  };
  if (user.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email))
    throw invalid();
  const purchase = {
    id: customerText(p.id, 160, true),
    userId: id,
    instructionId: customerText(p.instructionId, 200, true),
    title: customerText(p.title, 500, true),
    format: p.format === undefined ? "pdf" : p.format,
    amountMinor: p.amountMinor,
    currency: "RUB",
    createdAt: customerDate(p.createdAt, { now }),
  };
  if (
    !/^[A-Za-z0-9_-]+$/.test(purchase.id) ||
    !["pdf", "docx"].includes(purchase.format) ||
    !Number.isSafeInteger(purchase.amountMinor) ||
    purchase.amountMinor <= 0 ||
    purchase.amountMinor > 1000000000 ||
    p.currency !== "RUB"
  )
    throw invalid();
  return {
    protocol: 1,
    eventId,
    observedAt: customerDate(input.observedAt, { now }),
    user,
    purchase,
  };
}
export const SALES_PERIODS = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  total: null,
};
export const moscowDay = (ms) =>
  new Date(ms + 10800000).toISOString().slice(0, 10);
export function salesRange(period, now = Date.now()) {
  if (!Object.hasOwn(SALES_PERIODS, period)) throw invalid();
  const end = new Date(now).toISOString(),
    days = SALES_PERIODS[period];
  const start = days
    ? new Date(
        Date.parse(moscowDay(now) + "T00:00:00+03:00") - (days - 1) * 86400000,
      ).toISOString()
    : null;
  return { period, start, end, timeZone: "Europe/Moscow" };
}
