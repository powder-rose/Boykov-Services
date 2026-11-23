/* Public page counter. The hub connection key is never sent to the browser. */
(function () {
  "use strict";
  var config = window.BoykovStatistics;
  if (!config || window.boykovStatisticsStarted) return;
  window.boykovStatisticsStarted = true;
  var storageKey = "boykov_statistics_pending_v1",
    running = false,
    timer,
    attempts = 0;
  var uuidPattern =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  var localQueue = [];
  function privateMode() {
    return (
      navigator.doNotTrack === "1" ||
      window.doNotTrack === "1" ||
      navigator.globalPrivacyControl === true
    );
  }
  if (privateMode()) {
    try {
      localStorage.removeItem(storageKey);
    } catch (_) {}
    return;
  }
  var endpoint;
  try {
    endpoint = new URL(config.endpoint, location.href);
    if (
      endpoint.origin !== location.origin ||
      !/^https?:$/.test(endpoint.protocol)
    )
      return;
  } catch (_) {
    return;
  }
  function uuid() {
    if (window.crypto.randomUUID) return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map
      .call(bytes, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
    return (
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-" +
      hex.slice(12, 16) +
      "-" +
      hex.slice(16, 20) +
      "-" +
      hex.slice(20)
    );
  }
  function session() {
    var match = document.cookie.match(
      /(?:^|;\s*)boykov_statistics_session=([^;]+)/,
    );
    var id = match && uuidPattern.test(match[1]) ? match[1] : uuid();
    var domain = /^(?:[a-z0-9-]+\.)*energo-365\.ru$/.test(location.hostname)
      ? "; Domain=energo-365.ru"
      : "";
    document.cookie =
      "boykov_statistics_session=" +
      id +
      "; Max-Age=1800; Path=/; SameSite=Lax" +
      domain +
      (location.protocol === "https:" ? "; Secure" : "");
    return id;
  }
  function source() {
    var utm = new URL(location.href).searchParams.get("utm_source");
    if (utm && /^[A-Za-z0-9_.-]{1,64}$/.test(utm)) return "utm:" + utm;
    if (!document.referrer) return "direct";
    try {
      var host = new URL(document.referrer).hostname.toLowerCase();
      if (/^(?:[a-z0-9-]+\.)*energo-365\.ru$/.test(host)) return "internal";
      return /^[a-z0-9.-]{1,150}$/.test(host) ? "ref:" + host : "unknown";
    } catch (_) {
      return "unknown";
    }
  }
  function read() {
    var disk = [];
    try {
      disk = JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch (_) {}
    if (!Array.isArray(disk)) disk = [];
    var seen = {},
      now = Math.floor(Date.now() / 1000);
    return disk.concat(localQueue).filter(function (e) {
      if (
        !e ||
        !uuidPattern.test(e.eventId) ||
        !uuidPattern.test(e.sessionId) ||
        !Number.isInteger(e.at) ||
        e.at < now - 86400 ||
        e.at > now + 120 ||
        typeof e.pageToken !== "string" ||
        e.pageToken.length > 6000 ||
        typeof e.source !== "string" ||
        e.source.length > 160 ||
        seen[e.eventId]
      )
        return false;
      seen[e.eventId] = true;
      return true;
    });
  }
  function save(queue) {
    localQueue = queue;
    try {
      localStorage.setItem(storageKey, JSON.stringify(queue));
    } catch (_) {}
  }
  function retry() {
    clearTimeout(timer);
    if (attempts++ < 6)
      timer = setTimeout(
        deliver,
        Math.min(60000, 2000 * Math.pow(2, attempts)),
      );
  }
  async function deliver() {
    if (running || privateMode()) return;
    running = true;
    var batch = read().slice(-20).reverse();
    try {
      for (var i = 0; i < batch.length; i++) {
        var e = batch[i],
          body = new URLSearchParams();
        body.set("action", "boykov_statistics_view");
        ["eventId", "sessionId", "at", "source", "pageToken"].forEach(
          function (k) {
            body.set(k, e[k]);
          },
        );
        try {
          var response = await fetch(endpoint.href, {
            method: "POST",
            body: body,
            credentials: "same-origin",
            keepalive: true,
            signal:
              typeof AbortSignal !== "undefined" && AbortSignal.timeout
                ? AbortSignal.timeout(10000)
                : undefined,
          });
          var ack = await response.json();
          if (
            response.ok &&
            ack &&
            ack.ok === true &&
            (ack.eventId === e.eventId || ack.ignored === true)
          ) {
            save(
              read().filter(function (p) {
                return p.eventId !== e.eventId;
              }),
            );
          }
        } catch (_) {
          break;
        }
      }
    } finally {
      running = false;
      if (read().length) retry();
      else attempts = 0;
    }
  }
  function capture() {
    try {
      var queue = read();
      queue.push({
        eventId: uuid(),
        sessionId: session(),
        at: Math.floor(Date.now() / 1000),
        source: source(),
        pageToken: config.pageToken,
      });
      save(queue);
      deliver();
    } catch (_) {
      /* Unsupported browser must not interfere with forms. */
    }
  }
  if (document.visibilityState === "hidden") {
    var visible = function () {
      if (document.visibilityState !== "hidden") {
        document.removeEventListener("visibilitychange", visible);
        capture();
      }
    };
    document.addEventListener("visibilitychange", visible);
  } else capture();
  window.addEventListener("online", function () {
    attempts = 0;
    deliver();
  });
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) capture();
  });
})();
