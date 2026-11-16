import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import dotenv from "dotenv";
import { hashPassword } from "../server/auth.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.stdin.isTTY) {
  console.error("Запустите npm run setup в обычном интерактивном терминале.");
  process.exit(1);
}
emitKeypressEvents(process.stdin);
function secret(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const listener = (text, key) => {
      if (key?.ctrl && key.name === "c") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key?.name === "return") {
        process.stdin.off("keypress", listener);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(value);
      } else if (key?.name === "backspace") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (text && !key?.ctrl && !/[\x00-\x1f\x7f]/.test(text)) {
        value += text;
        process.stdout.write("*".repeat(text.length));
      }
    };
    process.stdin.on("keypress", listener);
  });
}
console.log(
  "Настройка boykov-services. Пароль хранится только в виде scrypt-хеша.",
);
const password = await secret("Общий пароль команды (10–256 символов): ");
if (password.length < 10 || password.length > 256) {
  console.error("Нужно от 10 до 256 символов.");
  process.exit(1);
}
if (password !== (await secret("Повторите пароль: "))) {
  console.error("Пароли не совпали. Настройки не изменены.");
  process.exit(1);
}
const envPath = path.join(root, ".env");
const env = existsSync(envPath)
  ? dotenv.parse(readFileSync(envPath))
  : dotenv.parse(readFileSync(path.join(root, ".env.example")));
env.AUTH_PASSWORD_HASH = await hashPassword(password);
env.WORKER_TOKEN ||= randomBytes(32).toString("hex");
// Quote values so $, #, whitespace and line breaks survive dotenv / Compose.
const content =
  Object.entries(env)
    .map(([key, value]) => `${key}='${String(value).replaceAll("'", "\\'")}'`)
    .join("\n") + "\n";
writeFileSync(envPath, content, { mode: 0o600 });
try {
  chmodSync(envPath, 0o600);
} catch {
  /* Windows uses filesystem ACLs. */
}
for (const service of ["contracts", "wordstat"]) {
  const file = path.join(root, `.env.${service}`);
  if (!existsSync(file)) copyFileSync(`${file}.example`, file);
}
console.log(
  "Готово. Скопируйте ключи сервисов в .env.contracts и .env.wordstat. Запуск: npm run dev",
);
