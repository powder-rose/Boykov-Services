import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
const password = "local-test-password-123";
const passwordHash = await hashPassword(password);
async function server(t, overrides = {}) {
  const dataDir =
    overrides.dataDir || (await mkdtemp(path.join(tmpdir(), "boykov-test-")));
  const app = await createApp({
    dataDir,
    passwordHash,
    allowedOrigins: ["http://localhost:5173"],
    secureCookies: false,
    worker: async (route) =>
      Response.json(route === "/jobs" ? { jobs: [] } : { aiConfigured: true }),
    isConfigured: () => true,
    batchOptions: { delayMs: 0 },
    requestWordstat: async ({ phrase }) => ({
      totalCount: "25",
      results: [{ phrase, count: "20" }],
      associations: [{ phrase: "test related", count: "5" }],
    }),
    ...overrides,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => listener.close(resolve));
    app.locals.db.close();
  }
  t.after(close);
  if (!overrides.dataDir)
    t.after(async () => {
      await close();
      await rm(dataDir, { recursive: true, force: true });
    });
  const request = (url, options = {}) => fetch(base + url, options);
  const jsonPost = (url, body, cookie = "") =>
    request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
  async function login() {
    const response = await jsonPost("/api/auth/login", { password });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  return { app, dataDir, request, jsonPost, login, close };
}
test("private APIs and downloads require a session", async (t) => {
  const s = await server(t);
  for (const route of [
    "/api/dashboard",
    "/api/system",
    "/api/contracts/jobs",
    "/api/contracts/files/test",
    "/api/wordstat/batches",
    "/api/files/test/test.xlsx",
  ])
    assert.equal((await s.request(route)).status, 401);
  assert.equal((await s.request("/healthz")).status, 200);
  assert.deepEqual(await (await s.request("/api/auth/session")).json(), {
    authenticated: false,
    configured: true,
  });
});
test("cookie has safe flags; logout revokes the session", async (t) => {
  const s = await server(t);
  const response = await s.jsonPost("/api/auth/login", { password });
  const header = response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  const cookie = header.split(";")[0];
  assert.equal(
    (await s.request("/api/dashboard", { headers: { Cookie: cookie } })).status,
    200,
  );
  await s.jsonPost("/api/auth/logout", {}, cookie);
  assert.equal(
    (await s.request("/api/dashboard", { headers: { Cookie: cookie } })).status,
    401,
  );
});
test("cross-site and missing CSRF headers are rejected", async (t) => {
  const s = await server(t);
  const headers = { "Content-Type": "application/json" };
  assert.equal(
    (
      await s.request("/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ password }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await s.request("/api/auth/login", {
        method: "POST",
        headers: {
          ...headers,
          "X-Boykov-Request": "1",
          Origin: "https://untrusted.example",
        },
        body: "{}",
      })
    ).status,
    403,
  );
});
test("session survives API restart and is invalidated by a new password", async (t) => {
  const s = await server(t);
  const cookie = await s.login();
  const { dataDir } = s;
  await s.close();
  const resumed = await server(t, { dataDir });
  assert.equal(
    (await resumed.request("/api/dashboard", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  await resumed.close();
  const changed = await server(t, {
    dataDir,
    passwordHash: await hashPassword("changed-test-password-456"),
  });
  assert.equal(
    (await changed.request("/api/dashboard", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
  await changed.close();
});
test("login attempts are limited", async (t) => {
  const s = await server(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await s.jsonPost("/api/auth/login", { password: "incorrect" })).status,
      401,
    );
  assert.equal((await s.jsonPost("/api/auth/login", { password })).status, 429);
});
test("Wordstat starts, checkpoints, exports Excel and protects its file", async (t) => {
  const s = await server(t);
  const cookie = await s.login();
  const response = await s.jsonPost(
    "/api/wordstat/batch/start",
    {
      queries: ["first phrase", "first phrase", "second phrase"],
      regionId: "225",
    },
    cookie,
  );
  assert.equal(response.status, 202);
  const batch = await response.json();
  await s.app.locals.store.wait(batch.id);
  const completed = await (
    await s.request(`/api/wordstat/batch/${batch.id}`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(completed.status, "completed");
  assert.equal(completed.total, 2);
  assert.equal(completed.processed, 2);
  assert.equal(completed.semanticCount, 4);
  assert.equal(completed.uniqueCount, 3);
  const download = await s.request(completed.downloadUrl, {
    headers: { Cookie: cookie },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(
    [...new Uint8Array(await download.arrayBuffer()).slice(0, 2)],
    [80, 75],
  );
  assert.equal((await s.request(completed.downloadUrl)).status, 401);
  const record = JSON.parse(
    await readFile(path.join(s.dataDir, "wordstat", batch.id, "0.json")),
  );
  assert.equal(record.data.totalCount, "25");
  assert.equal(
    (
      await s.request(`/api/files/${batch.id}/wrong.xlsx`, {
        headers: { Cookie: cookie },
      })
    ).status,
    404,
  );
});
test("invalid phrases and unavailable Wordstat credentials produce actionable errors", async (t) => {
  const s = await server(t);
  const cookie = await s.login();
  for (const queries of [[], [""], ["a".repeat(401)], Array(2001).fill("test")])
    assert.equal(
      (await s.jsonPost("/api/wordstat/batch/start", { queries }, cookie))
        .status,
      400,
    );
  assert.equal(
    (
      await s.jsonPost(
        "/api/wordstat/batch/start",
        { queries: ["test"], regionId: "../../" },
        cookie,
      )
    ).status,
    400,
  );
  const unconfigured = await server(t, { isConfigured: () => false });
  const otherCookie = await unconfigured.login();
  assert.equal(
    (
      await unconfigured.jsonPost(
        "/api/wordstat/batch/start",
        { queries: ["test"] },
        otherCookie,
      )
    ).status,
    503,
  );
});
test("upstream credential errors do not log the user out", async (t) => {
  const s = await server(t, {
    requestWordstat: async () => {
      throw new Error(
        "Wordstat API: HTTP 403. Проверьте API-ключ и права доступа.",
      );
    },
  });
  const cookie = await s.login();
  const response = await s.jsonPost(
    "/api/wordstat/batch/start",
    { queries: ["test"] },
    cookie,
  );
  const batch = await response.json();
  await s.app.locals.store.wait(batch.id);
  const result = await (
    await s.request(`/api/wordstat/batch/${batch.id}`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.equal(result.items[0].status, "error");
  assert.equal(
    (await s.request("/api/dashboard", { headers: { Cookie: cookie } })).status,
    200,
  );
});
test("document outage keeps the dashboard usable", async (t) => {
  const s = await server(t, {
    worker: async () => {
      throw new Error("offline");
    },
  });
  const cookie = await s.login();
  const dashboard = await (
    await s.request("/api/dashboard", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(dashboard.documentsAvailable, false);
  assert.deepEqual(dashboard.events, []);
  const state = await (
    await s.request("/api/system", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(state.documents.available, false);
});
