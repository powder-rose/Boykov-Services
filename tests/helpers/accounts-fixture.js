import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../../server/app.js";
import { hashPassword } from "../../server/auth.js";
import { createInitialAdmin } from "../../server/accounts.js";
export const sharedPassword = "fixture-shared-password",
  personalPassword = "fixture-personal-password";
const passwordHash = await hashPassword(sharedPassword);
const failure = (status) =>
  Object.assign(new Error("fixture worker unavailable"), { status });
export async function accountFixture(t, templateWorker) {
  const directory = await mkdtemp(join(tmpdir(), "boykov-accounts-"));
  const jobs = new Map();
  let app,
    server,
    base,
    hash = passwordHash,
    workerUnavailable = false,
    loseResponse = false,
    generateCalls = 0;
  const worker = async (route, options = {}) => {
    if (workerUnavailable) throw failure(503);
    if (templateWorker && route.startsWith("/templates"))
      return templateWorker(route, options);
    if (route === "/jobs") return Response.json({ jobs: [...jobs.values()] });
    if (route.startsWith("/jobs/")) {
      const job = jobs.get(route.slice(6));
      if (!job) throw failure(404);
      return Response.json(job);
    }
    if (route === "/generate") {
      generateCalls++;
      const input = JSON.parse(options.body),
        existing = jobs.get(input.requestId);
      const job = existing || {
        id: input.requestId,
        kind: "generate",
        title: "Тестовый договор",
        status: "completed",
        createdAt: new Date().toISOString(),
        downloadUrl: "/api/contracts/files/" + input.requestId,
      };
      jobs.set(job.id, job);
      if (loseResponse) {
        loseResponse = false;
        throw failure(503);
      }
      return Response.json(job);
    }
    if (route.startsWith("/files/")) return new Response("fixture document");
    return Response.json({ ok: true, aiConfigured: false });
  };
  async function start() {
    app = await createApp({
      dataDir: directory,
      passwordHash: hash,
      secureCookies: false,
      allowedOrigins: [],
      worker,
      isConfigured: () => false,
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = "http://127.0.0.1:" + server.address().port;
  }
  async function stop() {
    await new Promise((r) => server.close(r));
    app.locals.db.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, method = "GET", body, cookie = "", headers = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: cookie,
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const login = async (login, password = personalPassword) => {
    const response = await request(
      "/auth/login",
      "POST",
      login ? { login, password } : { password: sharedPassword },
    );
    if (response.status !== 200)
      throw new Error("Fixture login failed " + response.status);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const admin = await createInitialAdmin(app.locals.db, {
    login: "admin",
    name: "Тестовый администратор",
    password: personalPassword,
  });
  let adminCookie = await login("admin");
  const api = (path, method = "GET", body, cookie = adminCookie) =>
    request(path, method, body, cookie);
  const make = async (login, name = "Тестовый сотрудник", role = "sales") => {
    const response = await api("/accounts", "POST", {
      login,
      name,
      role,
      enabled: true,
      password: personalPassword,
    });
    if (response.status !== 201)
      throw new Error("Fixture account failed " + response.status);
    return (await response.json()).account;
  };
  const lead = async () => {
    const token = (
      await (await api("/leads/sites/security/token", "POST", {})).json()
    ).token;
    const response = await fetch(base + "/hooks/leads/security", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        eventId: randomUUID(),
        createdAt: new Date().toISOString(),
        name: "Тестовый клиент",
        fields: [],
      }),
    });
    const value = await response.json();
    return (await (await api("/leads/" + value.id)).json()).lead;
  };
  return {
    api,
    request,
    login,
    make,
    lead,
    admin,
    jobs,
    directory,
    get db() {
      return app.locals.db;
    },
    get base() {
      return base;
    },
    get adminCookie() {
      return adminCookie;
    },
    setUnavailable(value) {
      workerUnavailable = value;
    },
    loseNextResponse() {
      loseResponse = true;
    },
    get generateCalls() {
      return generateCalls;
    },
    restart: async (nextHash = hash) => {
      await stop();
      hash = nextHash;
      await start();
      adminCookie = await login("admin");
    },
  };
}
