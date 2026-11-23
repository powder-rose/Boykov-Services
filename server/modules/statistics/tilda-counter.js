/* Boykov Services: first-party analytics for the two configured Tilda sites. */
(function () {
  "use strict";
  try {
    var host = location.hostname.replace(/^www\./, "");
    if (
      location.protocol !== "https:" ||
      !["boykovgroup.ru", "elektrolaboratoriya-techotchet.ru"].includes(host) ||
      navigator.doNotTrack === "1" ||
      window.doNotTrack === "1" ||
      navigator.globalPrivacyControl === true ||
      window.__boykovTildaStatistics ||
      !window.crypto ||
      !window.crypto.randomUUID
    )
      return;
    window.__boykovTildaStatistics = true;
    var endpoint = "https://boykov-services.ru/hooks/tilda-statistics/view";
    var sessionKey = "boykov_tilda_statistics_session_v1",
      pendingKey = "boykov_tilda_statistics_pending_v1";
    var pending = [],
      busy = false,
      attempts = 0,
      retryTimer;
    var lifetime = 86400000;
    function read(key, fallback) {
      try {
        return JSON.parse(localStorage.getItem(key) || "null") || fallback;
      } catch (_) {
        return fallback;
      }
    }
    function write(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {
        /* Use the current page's in-memory queue. */
      }
    }
    function pull() {
      var disk = read(pendingKey, []);
      if (!Array.isArray(disk)) disk = [];
      var map = new Map();
      disk.concat(pending).forEach(function (item) {
        if (
          item &&
          item.event &&
          typeof item.event.eventId === "string" &&
          Number.isFinite(item.created) &&
          item.created <= Date.now() &&
          Date.now() - item.created < lifetime
        )
          map.set(item.event.eventId, item);
      });
      pending = Array.from(map.values())
        .sort(function (a, b) {
          return a.created - b.created;
        })
        .slice(-40);
    }
    function source() {
      var utm = new URL(location.href).searchParams.get("utm_source");
      if (utm && /^[A-Za-z0-9_.-]{1,64}$/.test(utm)) return "utm:" + utm;
      if (!document.referrer) return "direct";
      try {
        var ref = new URL(document.referrer).hostname.toLowerCase();
        if (ref.replace(/^www\./, "") === host) return "internal";
        return /^[a-z0-9](?:[a-z0-9.-]{0,148}[a-z0-9])?$/.test(ref)
          ? "ref:" + ref
          : "unknown";
      } catch (_) {
        return "unknown";
      }
    }
    function session() {
      var value = read(sessionKey, {}),
        now = Date.now();
      if (
        !value ||
        typeof value.id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          value.id,
        ) ||
        !Number.isFinite(value.at) ||
        value.at > now ||
        now - value.at >= 1800000
      )
        value = { id: crypto.randomUUID(), at: now };
      value.at = now;
      write(sessionKey, value);
      return value.id;
    }
    function schedule() {
      clearTimeout(retryTimer);
      if (pending.length && attempts++ < 5)
        retryTimer = setTimeout(
          send,
          Math.min(60000, 2000 * Math.pow(2, attempts)),
        );
    }
    async function send() {
      if (
        busy ||
        navigator.doNotTrack === "1" ||
        navigator.globalPrivacyControl === true
      )
        return;
      busy = true;
      try {
        pull();
        for (var item of pending.slice(0, 10)) {
          var response;
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=UTF-8" },
              body: JSON.stringify(item.event),
              credentials: "omit",
              keepalive: true,
              signal:
                typeof AbortSignal !== "undefined" && AbortSignal.timeout
                  ? AbortSignal.timeout(10000)
                  : undefined,
            });
            var ack = await response.json();
            if (
              !response.ok ||
              ack.ok !== true ||
              ack.eventId !== item.event.eventId
            )
              break;
            pull();
            pending = pending.filter(function (p) {
              return p.event.eventId !== item.event.eventId;
            });
            write(pendingKey, pending);
          } catch (_) {
            break;
          }
        }
      } finally {
        busy = false;
        if (pending.length) schedule();
        else attempts = 0;
      }
    }
    function capture() {
      try {
        if (location.pathname.length > 1000) return;
        pull();
        pending.push({
          created: Date.now(),
          event: {
            eventId: crypto.randomUUID(),
            sessionId: session(),
            path: location.pathname,
            source: source(),
          },
        });
        pending = pending.slice(-40);
        write(pendingKey, pending);
        send();
      } catch (_) {
        /* Statistics may never interfere with the site. */
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
      send();
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) capture();
    });
  } catch (_) {
    /* Fail silently on unsupported or privacy-restricted browsers. */
  }
})();
