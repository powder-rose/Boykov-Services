// Reads committed source files only. Documents, access tokens and card data never leave BoykovDocs.
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DocsSalesAgent } from "./sales-agent.mjs";
import {
  normalizeDocsCommerce,
  GENERATION_STATUSES,
} from "../../shared/docs-commerce.js";
const text = (s, max) =>
  typeof s === "string"
    ? s
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
        .trim()
        .slice(0, max)
    : "";
const date = (s) =>
  typeof s === "string" && Number.isFinite(Date.parse(s))
    ? new Date(s).toISOString()
    : null;
const email = (s) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(s, 254)) ? text(s, 254) : "";
const minor = (v) => {
  if (!["string", "number"].includes(typeof v)) throw Error("INVALID_AMOUNT");
  const m = String(v).match(/^(0|[1-9]\d{0,10})(?:\.(\d{1,2}))?$/);
  if (!m) throw Error("INVALID_AMOUNT");
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
};
export function validateCommerceConnection(config) {
  const u = new URL(config.endpoint);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/hooks/docs-customers/commerce" ||
    !/^[a-f0-9]{64}$/.test(config.token || "") ||
    !config.ordersDir
  )
    throw Error("INVALID_DOCS_COMMERCE_CONNECTION");
  return u.href;
}
export class DocsCommerceAgent extends DocsSalesAgent {
  static validateConnection = validateCommerceConnection;
  sourceName = "boykovdocs-commerce";
  constructor(config, options) {
    super(config, options);
    const orders = resolve(config.ordersDir),
      previous = this.get("orders_directory");
    if (previous && previous !== orders) {
      this.close();
      throw Error("DOCS_COMMERCE_QUEUE_BELONGS_TO_ANOTHER_SOURCE");
    }
    this.set("orders_directory", orders);
  }
  recordId(e) {
    return e.operation.kind + ":" + e.operation.id;
  }
  captureContent(e) {
    return { user: e.user, operation: e.operation };
  }
  acknowledges(ack, p, eventId) {
    return (
      ack.ok === true &&
      ack.eventId === eventId &&
      ack.recordId === this.recordId(p) &&
      ack.externalId === (p.user?.id || null)
    );
  }
  scan() {
    this.scanOk = false;
    this.invalid = 0;
    let users, wallet, orders;
    try {
      const rows = JSON.parse(
        readFileSync(join(this.config.sourceDir, "users.json"), "utf8"),
      );
      if (!Array.isArray(rows)) throw Error();
      users = new Map();
      for (const u of rows) {
        if (!u || typeof u.id !== "string" || !u.id || users.has(u.id))
          throw Error();
        users.set(u.id, {
          id: u.id,
          name: text(u.name, 200),
          phone: text(u.phone, 80),
          email: email(u.email),
          registeredAt: date(u.createdAt),
        });
      }
    } catch {
      this.errorCode = "users_read_failed";
      return;
    }
    try {
      try {
        wallet = JSON.parse(
          readFileSync(join(this.config.sourceDir, "wallets.json"), "utf8"),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        try {
          readFileSync(join(this.config.sourceDir, "wallets.json.initialized"));
          throw Error();
        } catch (marker) {
          if (marker.code !== "ENOENT") throw marker;
        }
        wallet = { version: 1, topups: [], payments: [], refunds: [] };
      }
      if (
        wallet.version !== 1 ||
        !["topups", "payments", "refunds"].every((k) =>
          Array.isArray(wallet[k]),
        )
      )
        throw Error();
    } catch {
      this.errorCode = "wallet_read_failed";
      return;
    }
    try {
      orders = readdirSync(this.config.ordersDir)
        .filter((n) => /^pg_[a-z0-9_-]{10,100}\.json$/i.test(n))
        .map((n) => {
          const path = join(this.config.ordersDir, n);
          if (!lstatSync(path).isFile()) throw Error();
          const row = JSON.parse(readFileSync(path, "utf8"));
          if (!row || Array.isArray(row) || row.id !== n.slice(0, -5))
            throw Error();
          // Keep a small projection rather than retaining every generated document in memory.
          return {
            ...Object.fromEntries(
              [
                "id",
                "ownerUserId",
                "ownerEmail",
                "profession",
                "amount",
                "currency",
                "status",
                "paidAt",
                "updatedAt",
                "generatedAt",
                "refundedAt",
                "transactionId",
                "fiscalPaymentLive",
                "failureCode",
              ].map((key) => [key, row[key]]),
            ),
            instructionId: row.instructionId || row.generatedInstruction?.id,
          };
        });
    } catch {
      this.errorCode = "orders_read_failed";
      return;
    }
    const events = [],
      ids = new Set(),
      transactions = new Set(),
      stamp = new Date(this.now()).toISOString();
    const user = (id) =>
      users.get(id) || {
        id,
        name: "",
        phone: "",
        email: "",
        registeredAt: null,
      };
    const push = (u, o) => {
      const e = normalizeDocsCommerce(
          {
            protocol: 1,
            eventId: "validation",
            observedAt: stamp,
            user: u,
            operation: o,
          },
          this.now(),
        ),
        key = this.recordId(e);
      if (ids.has(key)) throw Error();
      ids.add(key);
      events.push(e);
    };
    try {
      for (const row of orders) {
        const hasPayment =
          (typeof row.transactionId === "string" &&
            !!row.transactionId.trim()) ||
          (Number.isSafeInteger(row.transactionId) && row.transactionId > 0);
        if (
          !hasPayment ||
          !Object.hasOwn(GENERATION_STATUSES, row.status) ||
          row.fiscalPaymentLive === false ||
          row.status === "test_paid" ||
          ["PAYMENT_MISMATCH", "DUPLICATE_TRANSACTION"].includes(
            row.failureCode,
          )
        )
          continue;
        if (
          row.fiscalPaymentLive !== true &&
          row.fiscalPaymentLive !== undefined &&
          row.fiscalPaymentLive !== null
        )
          continue;
        const tx = String(row.transactionId);
        if (transactions.has(tx)) throw Error();
        transactions.add(tx);
        const paidAt = date(row.paidAt);
        if (!paidAt) throw Error();
        const owner = row.ownerUserId ? user(String(row.ownerUserId)) : null;
        if (owner && !owner.email) owner.email = email(row.ownerEmail);
        const refundedAt = date(row.refundedAt),
          generatedAt = date(row.generatedAt);
        const updatedAt =
          date(row.updatedAt) ||
          [paidAt, refundedAt, generatedAt].filter(Boolean).sort().at(-1);
        push(owner, {
          kind: "generation",
          id: row.id,
          title: text(row.profession, 500) || "Профессия не указана",
          amountMinor: minor(row.amount),
          currency: row.currency,
          createdAt: paidAt,
          updatedAt,
          status: row.status,
          generatedAt,
          refundedAt,
          instructionId: text(
            row.instructionId || row.generatedInstruction?.id,
            200,
          ),
          contactEmail: email(row.ownerEmail),
        });
      }
      const topups = new Map(),
        payments = new Map(),
        refunded = new Map();
      for (const o of wallet.topups) {
        if (!o || typeof o.id !== "string" || topups.has(o.id)) throw Error();
        topups.set(o.id, o);
      }
      for (const p of wallet.payments) {
        const o = topups.get(p?.orderId);
        if (
          !o ||
          o.userId !== p.userId ||
          o.amountMinor !== p.amountMinor ||
          o.currency !== "RUB" ||
          payments.has(p.id)
        )
          throw Error();
        payments.set(p.id, p);
        push(user(p.userId), {
          kind: "topup",
          id: p.id,
          referenceId: p.orderId,
          amountMinor: p.amountMinor,
          currency: o.currency,
          createdAt: p.createdAt,
          updatedAt: p.createdAt,
        });
      }
      const refundIds = new Set();
      for (const r of wallet.refunds) {
        const o = topups.get(r?.orderId),
          p = payments.get(r?.paymentId);
        if (
          !o ||
          o.userId !== r.userId ||
          !Number.isSafeInteger(r.amountMinor) ||
          r.amountMinor <= 0 ||
          refundIds.has(r.id) ||
          payments.has(r.id)
        )
          throw Error();
        refundIds.add(r.id);
        const sum = (refunded.get(r.paymentId) || 0) + r.amountMinor;
        if (sum > o.amountMinor) throw Error();
        refunded.set(r.paymentId, sum);
        if (!p) continue; // A refund received before Pay has not yet credited/debited this wallet.
        if (p.orderId !== r.orderId || p.userId !== r.userId) throw Error();
        push(user(r.userId), {
          kind: "topup-refund",
          id: r.id,
          referenceId: r.orderId,
          parentId: r.paymentId,
          amountMinor: r.amountMinor,
          currency: o.currency,
          createdAt: r.createdAt,
          updatedAt: r.createdAt,
        });
      }
    } catch {
      this.errorCode = "invalid_source_data";
      this.invalid = 1;
      return;
    }
    for (const e of events) this.capture(e);
    this.sourceCount = events.length;
    this.set("source_count", events.length);
    this.set("source_generated_at", stamp);
    const previous = Number(this.get("maximum_source_count") || 0);
    this.errorCode = events.length < previous ? "source_count_decreased" : "";
    this.set("maximum_source_count", Math.max(previous, events.length));
    this.scanOk = true;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.umask(0o077);
  let config;
  try {
    config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch {
    throw Error("DOCS_COMMERCE_CONFIGURATION_UNREADABLE");
  }
  const agent = new DocsCommerceAgent(config),
    stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => stop.abort());
  const cycle = async () => {
    try {
      const s = await agent.cycle();
      console.log(
        "DOCS_COMMERCE_SYNC=" +
          (s.scanOk && !s.rejected && !s.errorCode ? "OK" : "CHECK_REQUIRED") +
          " SOURCE_OPERATIONS=" +
          s.sourceCount +
          " PENDING=" +
          s.pending +
          " REJECTED=" +
          s.rejected,
      );
      return s.scanOk && !s.rejected && !s.errorCode;
    } catch {
      console.error("DOCS_COMMERCE_SYNC=CONNECTION_CHECK_REQUIRED");
      return false;
    }
  };
  try {
    if (process.argv.includes("--once"))
      process.exitCode = (await cycle()) ? 0 : 1;
    else
      while (!stop.signal.aborted) {
        await cycle();
        if (!stop.signal.aborted)
          await delay(30000, undefined, { signal: stop.signal }).catch((e) => {
            if (e.name !== "AbortError") throw e;
          });
      }
  } finally {
    agent.close();
  }
}
