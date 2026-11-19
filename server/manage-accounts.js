import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  installAccountsSchema,
  createInitialAdmin,
  prepareSalesAccounts,
} from "./accounts.js";

function secret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Для пароля нужен интерактивный терминал: docker compose exec app node server/manage-accounts.js init-admin",
    );
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.off("data", onData);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    function onData(chunk) {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Создание отменено."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (char >= " " && char !== "\u001b") value += char;
      }
    }
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdout.write(prompt);
    process.stdin.resume();
  });
}
let db;
try {
  const command = process.argv[2];
  if (!["init-admin", "prepare-sales"].includes(command))
    throw new Error("Команды: init-admin, prepare-sales (JSON через stdin).");
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path.join(config.dataDir, "platform.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
  );
  installAccountsSchema(db);
  if (command === "prepare-sales") {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536)
        throw new Error("Список слишком большой.");
    }
    const result = prepareSalesAccounts(db, JSON.parse(raw));
    console.log(
      "SALES_ACCOUNTS_ADDED=" +
        result.added +
        "\nSALES_ACCOUNTS_EXISTING=" +
        result.existing +
        "\nSALES_ACCOUNTS_PREPARED=OK",
    );
  } else {
    if (
      db
        .prepare(
          "SELECT count(*) AS n FROM workspace_accounts WHERE role='admin' AND enabled=1",
        )
        .get().n
    )
      throw new Error(
        "Администратор уже создан. Используйте раздел «Аккаунты».",
      );
    if (!process.stdin.isTTY)
      throw new Error(
        "Запустите без -T: docker compose exec app node server/manage-accounts.js init-admin",
      );
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let login, name;
    try {
      login =
        (await rl.question("Логин администратора [admin]: ")).trim() || "admin";
      name =
        (
          await rl.question("Имя в рабочем пространстве [Администратор]: ")
        ).trim() || "Администратор";
    } finally {
      rl.close();
    }
    let password = await secret("Пароль (12–128 символов; ввод скрыт): ");
    let confirmation = await secret("Повторите пароль: ");
    if (password !== confirmation)
      throw new Error("Пароли не совпадают. Аккаунт не создан.");
    const account = await createInitialAdmin(db, { login, name, password });
    password = "";
    confirmation = "";
    console.log("ADMIN_LOGIN=" + account.login + "\nADMIN_ACCOUNT=CREATED");
  }
} catch (error) {
  console.error("ACCOUNTS_SETUP_FAILED=" + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
