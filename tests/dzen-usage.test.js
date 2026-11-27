import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDzenStore } from "../server/modules/dzen/store.js";
import {
  createDzenUsageStore,
  parseDzenUsage,
} from "../server/modules/dzen/usage.js";
import { createDzenAi } from "../server/modules/dzen/ai.js";
import {
  DEFAULT_PROMPT,
  DEFAULT_SETTINGS,
} from "../server/modules/dzen/model.js";
import { accountFixture } from "./helpers/accounts-fixture.js";

const usage = (input = 200, output = 50) => ({
  result: {
    modelVersion: "5.0",
    usage: {
      inputTextTokens: String(input),
      completionTokens: String(output),
      totalTokens: String(input + output),
    },
  },
});

test("actual Yandex counts and saved tariffs determine cost without double counting reasoning tokens", () => {
  assert.deepEqual(parseDzenUsage(usage()), {
    modelVersion: "5.0",
    tokens: { input: 200, output: 50, total: 250 },
  });
  assert.equal(
    parseDzenUsage({
      result: {
        usage: {
          inputTextTokens: "7",
          completionTokens: "4",
          totalTokens: "12",
        },
      },
    }).tokens,
    null,
  );
  assert.equal(
    parseDzenUsage({
      result: { usage: { inputTextTokens: "invalid", completionTokens: "4" } },
    }).tokens,
    null,
  );
  assert.equal(parseDzenUsage({}).tokens, null);
});

test("ledger is durable, snapshots tariffs, groups unique comments, and does not hide unpriced requests", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let now = Date.parse("2026-11-26T20:59:00Z");
  const store = createDzenStore(db, () => now);
  store.addManual({ text: "Вопрос", author: "Читатель" }, "Администратор");
  const id = store.state().items[0].id;
  let ledger = createDzenUsageStore(db, () => now);
  const add = (kind, commentId, inputRub, outputRub, response, outcome) => {
    const request = ledger.start({ kind, commentId, inputRub, outputRub });
    if (response) ledger.record(request, parseDzenUsage(response));
    if (outcome) ledger.complete(request, outcome);
    return request;
  };
  add("reply", id, 1.2, 1.2, usage(), "reply");
  now += 120000;
  add("reply", id, 2, 3, usage(), "skip");
  add("preview", null, 1.2, 1.2, usage(100, 0), "skip");
  add("reply", id, 1.2, 1.2, null, "error");
  add("reply", id, 1.2, 1.2, null, null);
  ledger = createDzenUsageStore(db, () => now);
  const all = ledger.report("all");
  assert.equal(all.requests, 5);
  assert.equal(all.priced, 3);
  assert.equal(all.unknown, 2);
  assert.equal(all.costRub, 0.97);
  assert.equal(all.replyCostRub, 0.85);
  assert.equal(all.previewCostRub, 0.12);
  assert.equal(all.averageCommentRub, 0.85);
  assert.equal(all.comments, 1);
  assert.equal(all.totalTokens, 600);
  assert.equal(all.daily.length, 2);
  assert.equal(ledger.report("today").requests, 4);
  assert.equal(ledger.comment(id).requests, 4);
  assert.equal(ledger.comment(id).costRub, 0.85);
  assert.ok(
    all.rows.some(
      (row) => row.outcome === "interrupted" && row.costRub === null,
    ),
  );
  assert.throws(() => ledger.report("invalid"), /Некорректный период/);
});

test("preview, content filtered reply, regenerated reply and transport failure are individually metered", async (t) => {
  let call = 0;
  const ai = createDzenAi({
    folderId: "fixture-folder",
    apiKey: "fixture-key",
    fetcher: async () => {
      call++;
      if (call === 4) throw Error("timeout");
      return Response.json({
        ...usage(),
        result: {
          ...usage().result,
          alternatives: [
            call === 2
              ? { status: "ALTERNATIVE_STATUS_CONTENT_FILTER" }
              : { message: { text: "Спасибо за вопрос." } },
          ],
        },
      });
    },
  });
  const f = await accountFixture(t, undefined, {
    dzen: { token: "fixture-token".repeat(3), ai, autoTick: false },
  });
  const preview = await f.api("/dzen/preview", "POST", {
    text: "Пример",
    prompt: DEFAULT_PROMPT,
    maxChars: 700,
  });
  assert.equal(preview.status, 200);
  await f.api("/dzen/import", "POST", { text: "Вопрос", author: "Читатель" });
  let row = (await (await f.api("/dzen")).json()).items[0];
  for (let i = 0; i < 3; i++) {
    const res = await f.api(`/dzen/comments/${row.id}/generate`, "POST", {
      version: row.version,
    });
    assert.equal(res.status, 200);
    row = await res.json();
  }
  const report = await (await f.api("/dzen/usage?period=all")).json();
  assert.equal(report.requests, 4);
  assert.equal(report.priced, 3);
  assert.equal(report.unknown, 1);
  assert.equal(report.costRub, 0.9);
  assert.equal(report.replyCostRub, 0.6);
  const state = await (await f.api("/dzen")).json();
  assert.equal(state.items[0].aiUsage.requests, 3);
  assert.equal(state.items[0].aiUsage.costRub, 0.6);
  assert.equal((await fetch(f.base + "/api/dzen/usage")).status, 401);
  assert.equal(state.settings.aiInputRub, DEFAULT_SETTINGS.aiInputRub);
});
