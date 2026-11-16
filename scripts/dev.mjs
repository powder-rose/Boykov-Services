import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) !== 24) {
  console.error("Нужен Node.js 24 LTS.");
  process.exit(1);
}
if (!existsSync(".env")) {
  console.error("Сначала выполните npm run setup. Подробности в README.md.");
  process.exit(1);
}
const python =
  process.env.PYTHON_BIN ||
  path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
if (!existsSync(python) && !process.env.PYTHON_BIN) {
  console.error(
    "Создайте Python-окружение и установите worker/requirements.txt по инструкции README.md.",
  );
  process.exit(1);
}
const ready = spawnSync(
  python,
  ["-c", "import fastapi,uvicorn,requests,docx,pymupdf,num2words"],
  { stdio: "ignore" },
);
if (ready.status !== 0) {
  console.error(
    "Не установлены Python-зависимости. Выполните .venv\\Scripts\\python -m pip install -r worker/requirements.txt (Windows).",
  );
  process.exit(1);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    else child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) if (!child.killed) child.kill("SIGKILL");
    process.exit(code);
  }, 2500).unref();
  process.exitCode = code;
}
function start(command, args, name) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      TZ: "Europe/Moscow",
      PYTHONUTF8: "1",
    },
  });
  children.push(child);
  child.on("error", () => {
    console.error(`Не удалось запустить ${name}.`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${name} завершился (${code}).`);
      stop(code || 0);
    }
  });
}
start(
  python,
  [
    "-m",
    "uvicorn",
    "worker.service:app",
    "--host",
    "127.0.0.1",
    "--port",
    "8790",
    "--workers",
    "1",
  ],
  "Документы",
);
start(process.execPath, ["--watch", "server/index.js"], "API");
start(process.execPath, ["node_modules/vite/bin/vite.js"], "Vite");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
console.log(
  "boykov-services: http://localhost:5173 · Ctrl+C завершит все процессы",
);
