import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountFixture } from "./helpers/accounts-fixture.js";

test("personal cabinet contains only documents created by that session; ownership fields in request are ignored", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one"),
    b = await s.make("manager.two"),
    ca = await s.login(a.login),
    cb = await s.login(b.login),
    shared = await s.login(null);
  const id = randomUUID(),
    other = randomUUID(),
    common = randomUUID();
  assert.equal(
    (
      await s.api(
        "/contracts/generate",
        "POST",
        { requestId: id, createdBy: { id: b.id } },
        ca,
      )
    ).status,
    202,
  );
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: other }, cb))
      .status,
    202,
  );
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: common }, shared))
      .status,
    202,
  );
  const mine = await (
    await s.api("/me/documents?accountId=" + b.id, "GET", undefined, ca)
  ).json();
  assert.equal(mine.total, 1);
  assert.equal(mine.documents[0].id, id);
  assert.equal(mine.documents[0].createdBy.id, a.id);
  assert.equal(
    (await (await s.api("/me/documents", "GET", undefined, cb)).json())
      .documents[0].id,
    other,
  );
  assert.equal(
    (await (await s.api("/me/documents", "GET", undefined, shared)).json())
      .documents[0].id,
    common,
  );
  const history = await (await s.api("/contracts/jobs")).json();
  assert.equal(history.jobs.find((j) => j.id === id).createdBy.id, a.id);
  assert.equal((await s.request("/me/documents")).status, 401);
});

test("ownership is durable before worker creation: a lost acceptance response or restart cannot orphan a personal document", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one"),
    ca = await s.login(a.login),
    id = randomUUID();
  s.loseNextResponse();
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: id }, ca)).status,
    503,
  );
  assert.equal(
    s.db
      .prepare(
        "SELECT account_id FROM workspace_document_owners WHERE job_id=?",
      )
      .get(id).account_id,
    a.id,
  );
  await s.restart();
  assert.equal(
    (await (await s.api("/me/documents", "GET", undefined, ca)).json())
      .documents[0].id,
    id,
  );
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: id }, ca)).status,
    202,
  );
  assert.equal(
    (await (await s.api("/me/documents", "GET", undefined, ca)).json()).total,
    1,
  );
});

test("another account cannot re-use a generation ID and take credit; legacy jobs remain unassigned", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one"),
    b = await s.make("manager.two"),
    ca = await s.login(a.login),
    cb = await s.login(b.login),
    id = randomUUID(),
    legacy = randomUUID();
  await s.api("/contracts/generate", "POST", { requestId: id }, ca);
  const calls = s.generateCalls;
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: id }, cb)).status,
    409,
  );
  assert.equal(s.generateCalls, calls);
  s.jobs.set(legacy, {
    id: legacy,
    kind: "generate",
    title: "Старый договор",
    status: "completed",
    createdAt: "2026-11-18T10:00:00Z",
  });
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: legacy }, cb))
      .status,
    202,
  );
  assert.equal(
    (await (await s.api("/me/documents", "GET", undefined, cb)).json()).total,
    0,
  );
  assert.equal(
    s.db
      .prepare(
        "SELECT actor_kind FROM workspace_document_owners WHERE job_id=?",
      )
      .get(legacy).actor_kind,
    "legacy",
  );
});

test("worker outage does not break assigned leads; unknown document counts are not falsely reported as zero", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one"),
    ca = await s.login(a.login),
    lead = await s.lead();
  await s.api(
    "/leads/" + lead.id,
    "PATCH",
    {
      requestId: randomUUID(),
      version: 1,
      status: "working",
      note: "",
      claim: true,
    },
    ca,
  );
  s.setUnavailable(true);
  const docs = await (
    await s.api("/me/documents", "GET", undefined, ca)
  ).json();
  assert.equal(docs.available, false);
  assert.equal(docs.total, null);
  assert.equal(
    (await (await s.api("/me/leads", "GET", undefined, ca)).json()).counts
      .working,
    1,
  );
  const missing = randomUUID();
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: missing }, ca))
      .status,
    503,
  );
  assert.equal(
    s.db
      .prepare("SELECT * FROM workspace_document_owners WHERE job_id=?")
      .get(missing),
    undefined,
  );
  assert.equal(
    (await s.api("/me/documents?page=-1", "GET", undefined, ca)).status,
    400,
  );
  assert.equal(
    (await s.api("/contracts/generate", "POST", { requestId: "invalid" }, ca))
      .status,
    400,
  );
});
