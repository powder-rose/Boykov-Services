import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBatchStore } from "../server/modules/wordstat/batches.js";
import {
  WordstatRateLimitError,
  requestWordstatTop,
} from "../server/modules/wordstat/wordstat.js";
import { semanticRows } from "../server/modules/wordstat/export.js";
test("recovery reuses durable responses after export fails", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "boykov-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const requestWordstat = async ({ phrase }) => {
    requests++;
    return {
      totalCount: "12",
      results: [{ phrase, count: "10" }],
      associations: [],
    };
  };
  const store = await createBatchStore({
    exportsDir: directory,
    requestWordstat,
    delayMs: 0,
    writeExcel: async () => {
      throw new Error("disk");
    },
  });
  const batch = await store.start({
    queries: ["one", "two"],
    regionId: "all",
    regionName: "Все регионы",
  });
  await store.wait(batch.id);
  assert.equal(store.get(batch.id).status, "paused");
  assert.equal(requests, 2);
  const recovered = await createBatchStore({
    exportsDir: directory,
    requestWordstat,
    delayMs: 0,
  });
  recovered.resume(recovered.get(batch.id));
  await recovered.wait(batch.id);
  assert.equal(recovered.get(batch.id).status, "completed");
  assert.equal(requests, 2);
  assert.ok(
    (
      await readFile(
        path.join(directory, batch.id, recovered.get(batch.id).fileName),
      )
    ).length > 1000,
  );
});
test("429 quota wait retries the same phrase without saving it as an error", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "boykov-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.now(),
    calls = 0;
  const store = await createBatchStore({
    exportsDir: directory,
    delayMs: 0,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    requestWordstat: async () => {
      if (++calls === 1) throw new WordstatRateLimitError(clock + 10000);
      return { totalCount: "3", results: [], associations: [] };
    },
  });
  const job = await store.start({
    queries: ["phrase"],
    regionId: "all",
    regionName: "Все регионы",
  });
  await store.wait(job.id);
  assert.equal(calls, 2);
  assert.equal(store.get(job.id).status, "completed");
  assert.equal(store.get(job.id).items[0].status, "success");
});
test("Wordstat redacts upstream error bodies containing secrets", async () => {
  const original = {
    key: process.env.WORDSTAT_API_KEY,
    folder: process.env.WORDSTAT_FOLDER_ID,
  };
  process.env.WORDSTAT_API_KEY = "test-key";
  process.env.WORDSTAT_FOLDER_ID = "test-folder";
  try {
    await assert.rejects(
      requestWordstatTop(
        { phrase: "test" },
        {
          fetchImpl: async () =>
            Response.json({ error: "super-secret-token" }, { status: 403 }),
        },
      ),
      (error) =>
        error.message.includes("HTTP 403") &&
        !error.message.includes("super-secret-token"),
    );
  } finally {
    if (original.key === undefined) delete process.env.WORDSTAT_API_KEY;
    else process.env.WORDSTAT_API_KEY = original.key;
    if (original.folder === undefined) delete process.env.WORDSTAT_FOLDER_ID;
    else process.env.WORDSTAT_FOLDER_ID = original.folder;
  }
});
test("semantic export preserves large integer precision and rejects malformed counts", () => {
  const [row] = semanticRows({
    data: { totalCount: "9007199254740993", results: [], associations: [] },
  });
  assert.equal(row.count, "9007199254740993");
  assert.throws(() =>
    semanticRows({
      data: { totalCount: "text", results: [], associations: [] },
    }),
  );
});
