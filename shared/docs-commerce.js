import { customerDate, customerText } from "./docs-customers.js";
export const GENERATION_STATUSES = {
  paid: "Оплачено",
  moderating: "Проверка запроса",
  generating: "Генерируется",
  generated: "Готово",
  manual_review: "Ручная проверка",
  refunding: "Возврат в работе",
  refund_pending: "Ожидает возврата",
  refunded: "Возвращено",
};
const invalid = () =>
  Object.assign(new Error("Проверьте данные операции BoykovDocs."), {
    status: 400,
  });
const identifier = (v, max = 160) => {
  const s = customerText(v, max, true);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw invalid();
  return s;
};
export function normalizeDocsCommerce(input, now = Date.now()) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.protocol !== 1
  )
    throw invalid();
  const eventId = customerText(input.eventId, 160, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(eventId)) throw invalid();
  let user = null;
  if (input.user !== null) {
    const u = input.user;
    if (!u || typeof u !== "object" || Array.isArray(u)) throw invalid();
    user = {
      id: identifier(u.id),
      name: customerText(u.name, 200),
      email: customerText(u.email, 254),
      phone: customerText(u.phone, 80),
      registeredAt: customerDate(u.registeredAt, { nullable: true, now }),
    };
    if (user.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email))
      throw invalid();
  }
  const o = input.operation;
  if (
    !o ||
    typeof o !== "object" ||
    Array.isArray(o) ||
    !["generation", "topup", "topup-refund"].includes(o.kind)
  )
    throw invalid();
  if (
    !Number.isSafeInteger(o.amountMinor) ||
    o.amountMinor <= 0 ||
    o.amountMinor > 1000000000 ||
    o.currency !== "RUB"
  )
    throw invalid();
  const generation = o.kind === "generation";
  if (!generation && !user) throw invalid();
  const operation = {
    kind: o.kind,
    id: identifier(o.id),
    amountMinor: o.amountMinor,
    currency: "RUB",
    createdAt: customerDate(o.createdAt, { now }),
    updatedAt: customerDate(o.updatedAt, { now }),
    title: generation
      ? customerText(o.title, 500, true)
      : o.kind === "topup"
        ? "Пополнение счёта"
        : "Возврат пополнения",
    status: generation ? o.status : "confirmed",
    referenceId: generation ? "" : identifier(o.referenceId),
    parentId: o.kind === "topup-refund" ? identifier(o.parentId) : "",
    instructionId: generation ? customerText(o.instructionId, 200) : "",
    generatedAt: generation
      ? customerDate(o.generatedAt, { nullable: true, now })
      : null,
    refundedAt: generation
      ? customerDate(o.refundedAt, { nullable: true, now })
      : null,
    contactEmail: !user && generation ? customerText(o.contactEmail, 254) : "",
  };
  if (
    operation.contactEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operation.contactEmail)
  )
    throw invalid();
  if (
    operation.updatedAt < operation.createdAt ||
    (generation && !Object.hasOwn(GENERATION_STATUSES, operation.status)) ||
    (operation.refundedAt && operation.refundedAt < operation.createdAt) ||
    (operation.generatedAt && operation.generatedAt < operation.createdAt) ||
    (operation.refundedAt && operation.updatedAt < operation.refundedAt) ||
    (operation.generatedAt && operation.updatedAt < operation.generatedAt) ||
    (operation.status === "refunded" && !operation.refundedAt)
  )
    throw invalid();
  return {
    protocol: 1,
    eventId,
    observedAt: customerDate(input.observedAt, { now }),
    user,
    operation,
  };
}
