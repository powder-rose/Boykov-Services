import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const validHash = (value) =>
  /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value || "");
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64, options);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  if (
    !validHash(stored) ||
    typeof password !== "string" ||
    password.length > 256
  )
    return false;
  const [, salt, hash] = stored.split("$");
  return timingSafeEqual(
    await scrypt(password, salt, 64, options),
    Buffer.from(hash, "hex"),
  );
}
