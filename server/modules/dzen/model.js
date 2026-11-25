import { createHash } from "node:crypto";

export const DEFAULT_PROMPT = `Ты отвечаешь на комментарии читателей от имени экспертного блога Бойков Групп.
Пиши естественно, доброжелательно и по существу, без канцелярита. Не выдумывай факты, законы, цифры или обстоятельства. Если данных недостаточно, попроси уточнение.
Обычно 1–3 коротких абзаца. На возражения отвечай уважительно. На благодарность можно ответить коротко.
На спам, бессвязный текст и провокации, на которые нельзя конструктивно ответить, верни ровно SKIP.
По умолчанию не добавляй ссылки и рекламные призывы. Верни только текст ответа либо SKIP.`;

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "paused",
  channel: "Бойков Групп",
  ownNames: "",
  scanMinutes: 10,
  batchLimit: 5,
  dailyLimit: 10,
  maxChars: 700,
  prompt: DEFAULT_PROMPT,
});
export const MODES = ["paused", "review", "auto"];
export const STATUSES = [
  "new",
  "generating",
  "draft",
  "queued",
  "sending",
  "answered",
  "skipped",
  "error",
  "attention",
];
export const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const normalize = (value) =>
  String(value || "")
    .replace(/[\u200b\u2060\ufeff]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
const DZEN_HOSTS = new Set(["dzen.ru", "www.dzen.ru", "studio.dzen.ru"]);
export function studioUrl(value) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !DZEN_HOSTS.has(u.hostname) ||
      u.port ||
      u.username ||
      u.password ||
      !u.pathname.includes("/comments")
    )
      throw Error();
    const filter = u.searchParams.get("comments_data");
    u.search = "";
    if (filter === "n_reply") u.searchParams.set("comments_data", filter);
    u.hash = "";
    return u.toString();
  } catch {
    throw fail("Укажите HTTPS-ссылку на раздел комментариев Студии Дзена.");
  }
}
export function commentLink(value, fallback) {
  if (typeof value !== "string" || !value || value.length > 1500)
    return fallback;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !DZEN_HOSTS.has(u.hostname) ||
      u.port ||
      u.username ||
      u.password
    )
      return fallback;
    const comment = /^#comment_[A-Za-z0-9_-]{1,180}$/.test(u.hash)
      ? u.hash
      : "";
    u.search = "";
    u.hash = comment;
    return u.toString();
  } catch {
    return fallback;
  }
}
function string(value, max, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw fail("Проверьте длину и заполнение полей.");
  return value.trim();
}
function int(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw fail("Проверьте числовые ограничения.");
  return value;
}
export function parseSettings(input) {
  if (!input || !MODES.includes(input.mode))
    throw fail("Выберите режим работы.");
  const data = {
    mode: input.mode,
    channel: string(input.channel, 100, true),
    ownNames: string(input.ownNames, 1000),
    scanMinutes: int(input.scanMinutes, 5, 120),
    batchLimit: int(input.batchLimit, 1, 10),
    dailyLimit: int(input.dailyLimit, 1, 50),
    maxChars: int(input.maxChars, 120, 1500),
    prompt: string(input.prompt, 12000, true),
  };
  if (data.mode === "auto" && !ownNames(data).length)
    throw fail("Для автоответов укажите имя автора своего канала.");
  return data;
}
export function ownNames(settings) {
  return settings.ownNames
    .split(/[\n;,]+/)
    .map((x) => normalize(x).toLocaleLowerCase("ru"))
    .filter(Boolean);
}
export function isOwn(item, settings) {
  return (
    item.isOwn ||
    ownNames(settings).includes(normalize(item.author).toLocaleLowerCase("ru"))
  );
}
export function parseComment(input, source, verified = false) {
  if (!input || typeof input !== "object")
    throw fail("Некорректный комментарий.");
  const author = string(input.author ?? "", 180),
    text = string(input.text, 6000, true);
  const article = string(input.articleTitle ?? "", 500),
    created = string(input.createdLabel ?? "", 140);
  const externalId =
    typeof input.commentId === "string" &&
    /^[A-Za-z0-9_-]{1,180}$/.test(input.commentId)
      ? input.commentId
      : "";
  const href = commentLink(input.href, source);
  const fingerprint = digest(
    [
      normalize(author).toLocaleLowerCase("ru"),
      normalize(text),
      normalize(article),
      href ?? "",
    ].join("\n"),
  );
  const key = externalId ? `id:${externalId}` : `text:${fingerprint}`;
  return {
    key,
    externalId,
    author,
    text,
    article,
    created,
    href,
    fingerprint,
    isOwn: input.isOwn === true,
    eligible: Boolean(
      externalId &&
      author &&
      verified &&
      input.canReply === true &&
      input.isOwn !== true,
    ),
  };
}
export function validateReply(value, max) {
  const text = string(value, max, true);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw fail("Ответ содержит недопустимые символы.");
  return text;
}
export function cleanReply(value, max) {
  let text = String(value ?? "")
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^\s*(?:ответ|reply)\s*:\s*/i, "")
    .trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      text =
        [parsed.reply, parsed.text, parsed.answer].find(
          (x) => typeof x === "string",
        ) || "";
    } catch {
      return "";
    }
  }
  text = text
    .trim()
    .replace(/^[«"]|[»"]$/g, "")
    .trim();
  if (
    !text ||
    /^skip\b/i.test(text) ||
    /^(я не могу|не могу обсуждать|i (can't|cannot) help)/i.test(text)
  )
    return "";
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  if (text.length > max) {
    const cut = text.slice(0, max),
      end = Math.max(
        cut.lastIndexOf("."),
        cut.lastIndexOf("!"),
        cut.lastIndexOf("?"),
      );
    text =
      end >= max * 0.55
        ? cut.slice(0, end + 1)
        : cut.replace(/\s+\S*$/, "").trim();
  }
  return text.trim();
}
export const automaticReplyAllowed = (text) =>
  Boolean(
    text &&
    text.length >= 3 &&
    !/(https?:\/\/|www\.|\b[\w-]+\.(ru|com|net|рф)\b|```)/iu.test(text),
  );
