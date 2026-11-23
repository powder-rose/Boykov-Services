import { open, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  docsStatisticsSite,
  NativeReportBuilder,
  reportPeriod,
} from "../../shared/statistics.js";

const SESSION_GAP = 30 * 60000;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_WINDOW_EVENTS = 500000;
const endpoint = "https://boykov-services.ru/hooks/docs-customers/statistics";
const fail = (code) => Object.assign(new Error(code), { code });

// Only aggregate counts leave the source server. Do not copy visitor IDs into
// the delivery state, logs or HTTP requests.
export async function collectBoykovDocs(file, now = Date.now()) {
  const range = reportPeriod("90", now);
  const events = [];
  let coverage = Infinity,
    count = 0,
    filteredSince = Infinity;
  const source = await open(file, "r");
  try {
    const { size } = await source.stat();
    if (!size || size > MAX_SOURCE_BYTES)
      throw fail("SOURCE_EMPTY_OR_TOO_LARGE");
    // Without a final newline, the writer may still be appending a record.
    // Read exactly the original size; never wait for an active writer.
    let remainder = Buffer.alloc(0);
    const chunk = Buffer.alloc(65536);
    for (let offset = 0; offset < size; ) {
      const { bytesRead } = await source.read(
        chunk,
        0,
        Math.min(chunk.length, size - offset),
        offset,
      );
      if (!bytesRead) throw fail("SOURCE_CHANGED");
      offset += bytesRead;
      const data = Buffer.concat([remainder, chunk.subarray(0, bytesRead)]);
      let start = 0,
        end;
      while ((end = data.indexOf(10, start)) !== -1) {
        if (end - start > 4096) throw fail("SOURCE_INVALID_RECORD");
        const line = data.subarray(start, end).toString("utf8").trim();
        start = end + 1;
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          throw fail("SOURCE_INVALID_RECORD");
        }
        const at = typeof row?.ts === "string" ? Date.parse(row.ts) : NaN;
        if (
          !Number.isFinite(at) ||
          at <= 0 ||
          new Date(at).toISOString() !== row.ts ||
          at > now + 120000 ||
          typeof row.visitor !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.visitor)
        )
          throw fail("SOURCE_INVALID_RECORD");
        count++;
        if (row.schema !== undefined && row.schema !== 2)
          throw fail("SOURCE_INVALID_RECORD");
        if (row.schema === 2 && !/^[a-f0-9]{64}$/.test(row.eventId || ""))
          throw fail("SOURCE_INVALID_RECORD");
        if (at >= range.end) continue;
        if (row.schema === 2) filteredSince = Math.min(filteredSince, at);
        coverage = Math.min(coverage, at);
        if (at >= range.start - SESSION_GAP) {
          if (events.length >= MAX_WINDOW_EVENTS)
            throw fail("SOURCE_WINDOW_TOO_LARGE");
          events.push({
            at,
            visitor: row.visitor,
            eventId: row.schema === 2 ? row.eventId : null,
          });
        }
      }
      remainder = Buffer.from(data.subarray(start));
      if (remainder.length > 4096) throw fail("SOURCE_INVALID_RECORD");
    }
    if ((await source.stat()).size < size) throw fail("SOURCE_CHANGED");
  } finally {
    await source.close();
  }
  if (!Number.isFinite(coverage))
    throw fail("SOURCE_WAITING_FOR_COMPLETED_MINUTE");
  const builder = new NativeReportBuilder({
    host: docsStatisticsSite.host,
    kind: "boykovdocs",
    now,
    articles: false,
    leads: false,
    sources: false,
  });
  const lastSeen = new Map();
  events.sort((a, b) => a.at - b.at);
  const seenEvents = new Set();
  for (const { at, visitor, eventId } of events) {
    if (eventId && seenEvents.has(eventId)) continue;
    if (eventId) seenEvents.add(eventId);
    const previous = lastSeen.get(visitor);
    if (previous === undefined || at - previous >= SESSION_GAP)
      builder.record("visits", at);
    lastSeen.set(visitor, at);
    builder.record("views", at);
  }
  const packet = builder.packet();
  packet.coverageFrom = new Date(coverage).toISOString();
  if (Number.isFinite(filteredSince))
    packet.filteredSince = new Date(filteredSince).toISOString();
  return { count, packet };
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw fail("STATE_UNREADABLE");
  }
}
async function writeState(file, value) {
  const temporary = file + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, file);
}
function validateConfig(config) {
  if (
    config.endpoint !== endpoint ||
    typeof config.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(config.token) ||
    typeof config.sourceDir !== "string" ||
    typeof config.stateDir !== "string"
  )
    throw fail("CONFIG_INVALID");
}
export async function runBoykovDocsCycle(
  config,
  { now = Date.now(), fetcher = fetch } = {},
) {
  validateConfig(config);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const cacheFile = path.join(config.stateDir, "last-packet.json");
  const statusFile = path.join(config.stateDir, "status.json");
  const generatedAt = new Date(reportPeriod("90", now).end).toISOString();
  try {
    let saved = await readState(cacheFile);
    if (saved && saved.packet?.generatedAt > generatedAt)
      throw fail("CLOCK_MOVED_BACKWARD");
    if (saved?.packet?.generatedAt !== generatedAt) {
      const next = await collectBoykovDocs(
        path.join(config.sourceDir, "visitor-events.jsonl"),
        now,
      );
      if (
        saved &&
        (next.count < saved.count ||
          next.packet.coverageFrom > saved.packet.coverageFrom)
      )
        throw fail("SOURCE_HISTORY_DECREASED");
      saved = next;
      // Preserve the exact minute snapshot before sending: a retry must not
      // create a different packet if the central server already saved it.
      await writeState(cacheFile, saved);
    }
    const response = await fetcher(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.token,
      },
      body: JSON.stringify(saved.packet),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw fail("HUB_HTTP_" + response.status);
    const ack = await response.json();
    if (
      ack.ok !== true ||
      ack.siteId !== docsStatisticsSite.id ||
      ack.generatedAt !== generatedAt ||
      ack.ignored === true
    )
      throw fail("HUB_INVALID_ACK");
    const status = {
      ok: true,
      generatedAt,
      checkedAt: new Date(now).toISOString(),
    };
    await writeState(statusFile, status);
    return status;
  } catch (error) {
    const code =
      typeof error.code === "string" && /^[A-Z0-9_]{1,60}$/.test(error.code)
        ? error.code
        : "DELIVERY_FAILED";
    await writeState(statusFile, {
      ok: false,
      errorCode: code,
      checkedAt: new Date(now).toISOString(),
    });
    throw fail(code);
  }
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  validateConfig(config);
  const once = process.argv.includes("--once");
  do {
    try {
      const status = await runBoykovDocsCycle(config);
      console.log(
        "BOYKOVDOCS_STATISTICS=OK GENERATED_AT=" + status.generatedAt,
      );
    } catch (error) {
      console.error(
        "BOYKOVDOCS_STATISTICS=ERROR CODE=" + (error.code || "DELIVERY_FAILED"),
      );
      if (once) process.exitCode = 1;
    }
    if (!once) await delay(60000 - (Date.now() % 60000) + 1000);
  } while (!once);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error("BOYKOVDOCS_STATISTICS=ERROR CODE=START_FAILED");
    process.exitCode = 1;
  });
