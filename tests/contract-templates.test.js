import test from "node:test";
import assert from "node:assert/strict";
import { accountFixture } from "./helpers/accounts-fixture.js";
import templates from "../shared/templates.json" with { type: "json" };

test("template routes are private; edits use the employee from the session, not the request", async (t) => {
  const calls = [];
  const fixture = await accountFixture(t, async (route, options) => {
    calls.push({ route, options });
    return route.includes("/files/")
      ? new Response("word-file")
      : Response.json({ templates, active: { version: 2 } });
  });
  const prefix = "/contracts/templates";
  const path = prefix + "/specons";
  const shared = await fixture.login(null);
  const sales = await fixture.make("template.editor", "Редактор договоров");
  const cookie = await fixture.login(sales.login);
  assert.equal((await fixture.request(prefix)).status, 401);
  assert.equal(
    (await (await fixture.api(prefix, "GET", undefined, shared)).json())
      .canEdit,
    false,
  );
  assert.equal(
    (await (await fixture.api(prefix, "GET", undefined, cookie)).json())
      .canEdit,
    true,
  );
  const before = calls.length;
  for (const route of ["/publish", "/draft", "/restore", "/discard"])
    assert.equal(
      (await fixture.api(path + route, "POST", {}, shared)).status,
      403,
    );
  assert.equal(
    (await fixture.api(path + "/editor", "GET", undefined, shared)).status,
    403,
  );
  assert.equal(calls.length, before);
  await fixture.api(path + "/editor", "GET", undefined, cookie);
  assert.equal(
    calls.at(-1).route,
    "/templates/specons/editor?owner=" + sales.id,
  );
  const response = await fixture.api(
    path + "/publish",
    "POST",
    {
      actorId: fixture.admin.id,
      actorName: "Подмена имени",
      expectedVersion: 1,
      changes: [
        { id: "word/document.xml#1", text: "Новый текст", other: "ignored" },
      ],
      note: "Изменение условий",
    },
    cookie,
  );
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(calls.at(-1).options.body);
  assert.equal(forwarded.actorId, sales.id);
  assert.equal(forwarded.actorName, sales.name);
  assert.deepEqual(forwarded.changes, [
    { id: "word/document.xml#1", text: "Новый текст" },
  ]);
  const form = new FormData();
  form.set("expectedVersion", "1");
  form.set("actorId", fixture.admin.id);
  form.set("file", new Blob(["test document"]), "Новый.docx");
  const uploaded = await fetch(fixture.base + "/api" + path + "/draft", {
    method: "POST",
    headers: { Cookie: cookie, "X-Boykov-Request": "1" },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const upload = calls.at(-1);
  assert.equal(upload.route, "/templates/specons/draft");
  assert.equal(upload.options.body.get("actorId"), sales.id);
  assert.equal(upload.options.body.get("file").name, "Новый.docx");
  const file = await fixture.api(
    path + "/files/1?format=docx",
    "GET",
    undefined,
    shared,
  );
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "word-file");
  assert.equal(file.headers.get("cache-control"), "private, no-store");
  assert.match(file.headers.get("content-disposition"), /specons-v1\.docx/);
  const last = calls.length;
  assert.equal((await fixture.api(prefix + "/unknown/history")).status, 404);
  assert.equal((await fixture.api(path + "/files/1?format=html")).status, 400);
  assert.equal(
    (
      await fixture.api(path + "/publish", "POST", {
        expectedVersion: 0,
        changes: [],
      })
    ).status,
    400,
  );
  assert.equal(calls.length, last);
});
