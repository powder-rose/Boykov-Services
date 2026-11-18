import { createReadStream } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";

const [source, destination] = process.argv.slice(2);
if (!source || !destination || resolve(source) === resolve(destination))
  throw new Error(
    "Usage: node backfill-security-outbox.mjs EXISTING_LEADS_JSONL HUB_OUTBOX_JSONL",
  );
process.umask(0o077);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const file = await open(destination, "a", 0o600);
let count = 0;
try {
  const lines = createInterface({
    input: createReadStream(source, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim()) {
      await file.writeFile(line + "\n");
      count++;
    }
  }
  await file.sync();
} finally {
  await file.close();
}
const directory = await open(dirname(destination), "r");
try {
  await directory.sync();
} finally {
  await directory.close();
}
console.log("BACKFILLED_ROWS=" + count);
