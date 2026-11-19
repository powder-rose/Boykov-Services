const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const keyName = (key) => key.toLocaleLowerCase("ru").replace(/[\s_-]/g, "");

// Sort object keys so JSON and URL-encoded retries have the same fingerprint.
function stable(value, depth = 0) {
  if (depth > 8) throw invalid("Слишком сложные поля заявки Tilda.");
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key], depth + 1)]),
    );
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null)
    throw invalid("Некорректное поле заявки Tilda.");
  return value;
}

export function tildaEventId(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid("Не удалось прочитать заявку Tilda.");
  if (
    typeof input.tranid !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,149}$/.test(input.tranid)
  )
    throw invalid("Tilda не передала корректный номер заявки tranid.");
  return "tilda:" + input.tranid;
}

export function mapTildaLead(input, { createdAt, host, referer }) {
  const eventId = tildaEventId(input);
  const keys = Object.keys(input).filter(
    (key) => key.toUpperCase() !== "COOKIES",
  );
  if (keys.length > 100) throw invalid("Слишком много полей заявки Tilda.");
  const fields = keys.sort().map((label) => {
    const raw = input[label];
    const value = typeof raw === "string" ? raw : JSON.stringify(stable(raw));
    if (
      !label.trim() ||
      label.length > 200 ||
      label.includes("\0") ||
      value.length > 16000 ||
      value.includes("\0")
    )
      throw invalid("Проверьте состав и длину полей заявки Tilda.");
    return { label, value };
  });
  const pick = (names, limit) => {
    for (const name of names) {
      const found = fields.find((field) => keyName(field.label) === name);
      if (found?.value.trim()) return found.value.trim().slice(0, limit);
    }
    return "";
  };
  let pageUrl = `https://${host}/`;
  try {
    const url = new URL(referer);
    if (
      /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      url.hostname.replace(/^www\./, "") === host &&
      url.href.length <= 2000
    )
      pageUrl = url.href;
  } catch {
    // A missing Referer does not make an otherwise valid sale disappear.
  }
  return {
    eventId,
    createdAt,
    name: pick(["name", "fullname", "имя", "фио", "вашеимя"], 200),
    phone: pick(
      ["phone", "telephone", "tel", "телефон", "номертелефона", "ваштелефон"],
      80,
    ),
    email: pick(["email", "mail", "почта", "электроннаяпочта"], 254),
    service: pick(["service", "услуга", "услуги", "subject", "тема"], 500),
    message: pick(
      ["comments", "comment", "message", "сообщение", "комментарий", "вопрос"],
      12000,
    ),
    form: pick(["formname", "formid"], 300) || "Форма Tilda",
    fields,
    pageUrl,
  };
}
