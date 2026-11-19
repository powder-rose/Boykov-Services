import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { collectNative } from "./collect.mjs";
export function statisticsEndpoint(leadsEndpoint) {
  const u = new URL(leadsEndpoint);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/^\/hooks\/leads\/[a-zA-Z0-9_-]+$/.test(u.pathname)
  )
    throw Error("INVALID_NATIVE_ENDPOINT");
  u.pathname = u.pathname.replace("/hooks/leads/", "/hooks/statistics/");
  return u.href;
}
export async function writePrivate(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID();
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
export async function runNativeCycle(
  config,
  { fetcher = fetch, now = Date.now() } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(config.token || ""))
    throw Error("INVALID_NATIVE_KEY");
  const endpoint = statisticsEndpoint(config.leadsEndpoint),
    siteId = new URL(endpoint).pathname.split("/").at(-1);
  const stateFile = join(config.stateDir, "last-packet.json");
  let packet;
  try {
    packet = await collectNative({ ...config, now });
    await writePrivate(stateFile, packet);
  } catch (error) {
    // Keep a queued complete snapshot; never replace it with an empty report.
    let queued;
    try {
      queued = JSON.parse(await readFile(stateFile, "utf8"));
    } catch {}
    if (!queued || queued.host !== config.host || queued.source !== config.kind)
      throw error;
    packet = queued;
  }
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + config.token,
    },
    body: JSON.stringify(packet),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("NATIVE_HTTP_" + response.status);
  const ack = await response.json();
  if (
    ack.ok !== true ||
    ack.siteId !== siteId ||
    ack.generatedAt !== packet.generatedAt
  )
    throw Error("INVALID_NATIVE_ACK");
  const stale = now - Date.parse(packet.generatedAt) > 180000;
  await writePrivate(join(config.stateDir, "status.json"), {
    ok: !stale,
    generatedAt: packet.generatedAt,
    deliveredAt: new Date(now).toISOString(),
  });
  return { ok: !stale, generatedAt: packet.generatedAt };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.umask(0o077);
  const file = process.argv[2];
  if (!file) throw Error("Usage: node agent.mjs CONFIG_JSON [--once]");
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw Error("NATIVE_CONFIGURATION_UNREADABLE");
  }
  const cycle = async () => {
    try {
      const result = await runNativeCycle(config);
      console.log(
        "NATIVE_STATISTICS=" +
          (result.ok ? "OK" : "STALE") +
          " GENERATED_AT=" +
          result.generatedAt,
      );
      return result.ok;
    } catch (error) {
      console.error(
        "NATIVE_STATISTICS_CHECK_REQUIRED=" +
          (/^[A-Z_0-9]+$/.test(error.message)
            ? error.message
            : "SOURCE_OR_CONNECTION_ERROR"),
      );
      return false;
    }
  };
  if (process.argv.includes("--once"))
    process.exitCode = (await cycle()) ? 0 : 1;
  else {
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => stop.abort());
    while (!stop.signal.aborted) {
      await cycle();
      if (!stop.signal.aborted)
        await delay(60000, undefined, { signal: stop.signal }).catch(
          (error) => {
            if (error.name !== "AbortError") throw error;
          },
        );
    }
  }
}
