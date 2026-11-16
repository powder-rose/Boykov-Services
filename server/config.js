import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({ path: path.join(root, ".env"), quiet: true });
export function serviceEnv(filename) {
  try {
    return dotenv.parse(readFileSync(path.join(root, filename)));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
const wordstat = serviceEnv(".env.wordstat");
// Each service has its own Yandex account; never overwrite document credentials.
process.env.WORDSTAT_API_KEY ||= wordstat.YANDEX_API_KEY || "";
process.env.WORDSTAT_FOLDER_ID ||= wordstat.YANDEX_FOLDER_ID || "";
export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(root, process.env.DATA_DIR || "data"),
  passwordHash: process.env.AUTH_PASSWORD_HASH || "",
  secureCookies: process.env.COOKIE_SECURE === "true",
  allowedOrigins: (
    process.env.APP_ORIGINS ||
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787"
  )
    .split(",")
    .map((v) => v.trim()),
  workerUrl: process.env.WORKER_URL || "http://127.0.0.1:8790",
  workerToken: process.env.WORKER_TOKEN || "",
  clientDir: path.join(root, "dist"),
  trustProxy: process.env.TRUST_PROXY === "loopback" ? "loopback" : false,
};
