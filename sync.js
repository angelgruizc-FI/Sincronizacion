/* DUNNE · Sincronización de pantallas (panel de control ⇄ cerebro)
 *
 * Se activa SOLO si la URL trae ?rol=panel o ?rol=cerebro. Sin eso, el sitio funciona exactamente igual que siempre.
 *   ?rol=panel   → página normal (panel, explicación, botones). Lo que se haga aquí se manda a la otra pantalla.
 *   ?rol=cerebro → solo se ve el cerebro 3D; copia lo que hace el panel.
 *   &sala=NOMBRE → sala compartida (default "dunne"). Ambas pantallas deben usar la misma.
 *   &fb=URL      → URL de Firebase Realtime Database (opcional; si no, usa FIREBASE_URL de abajo).
 *
 * Canales:
 *   • BroadcastChannel: funciona entre ventanas del MISMO navegador/computadora (sin internet).
 *   • Firebase Realtime Database (REST + EventSource): funciona entre computadoras distintas.
 */
(function () {
  "use strict";

  /* Pega aquí la URL de tu base de datos, p. ej. "https://dunne-expo-default-rtdb.firebaseio.com" (sin / al final).
     Déjala vacía ("") para usar solo varias ventanas en la misma computadora. */
  var FIREBASE_URL = "";

  var P = new URLSearchParams(location.search);
  var ROL = P.get("rol");
  if (ROL !== "panel" && ROL !== "cerebro") return;
  var SALA = (P.get("sala") || "dunne").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "dunne";
  var FB = (P.get("fb") || FIREBASE_URL || "").replace(/\/+$/, "");
  var PAGE = location.pathname.split("/").pop() || "index.html";
  var UID = Math.random().toString(36).slice(2, 10);
  var isPanel = ROL === "panel";
  var SKIP_KEYS = { sound: 1 };           // el audio solo suena en el panel
  var evtN = 0, seenEvt = {}, lastAck = 0, lastRecv = 0, baselineDone = false;

  function qs() {
    var q = "?rol=" + ROL + "&sala=" + encodeURIComponent(SALA);
    if (P.get("fb")) q += "&fb=" + encodeURIComponent(P.get("fb"));
    return q;
  }
  function urlFor(page) { return page.split("?")[0] + qs(); }

  /* ---------- Enlaces internos conservan rol y sala ---------- */
  function fixLinks() {
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function (a) {
      var h = a.getAttribute("href");
      if (!h || /^([a-z]+:|#|\/\/)/i.test(h) || !/\.html?($|\?|#)/i.test(h)) return;
      a.setAttribute("href", urlFor(h.split("#")[0]));
    });
  }
  fixLinks();
  new MutationObserver(function () { clearTimeout(fixLinks._t); fixLinks._t = setTimeout(fixLinks, 200); })
    .observe(document.body, { childList: true, subtree: true });

  /* ---------- Transporte ---------- */
  var handlers = [];
  var bc = null;
  try { bc = new BroadcastChannel("dunne-" + SALA); bc.onmessage = function (e) { deliver(e.data); }; } catch (e) {}
  function deliver(m) { if (m && m.uid !== UID) { lastRecv = Date.now(); handlers.forEach(function (h) { h(m); }); } }

  function put(path, obj) {
    if (!FB) return;
    try { fetch(FB + "/salas/" + SALA + path + ".json", { method: "PUT", body: JSON.stringify(obj), keepalive: true }).catch(function () {}); } catch (e) {}
  }
  function send(m) {
    m.uid = UID;
    if (bc) { try { bc.postMessage(m); } catch (e) {} }
    if (!FB) return;
    if (m.type === "state") put("/state", m);
    else if (m.type === "evt") put("/evt", m);
    else if (m.type === "ack") put("/ack", m);
    /* "hello" no hace falta con Firebase: el estado queda guardado */
  }
  function listenFirebase() {
    if (!FB || !window.EventSource) return;
    var es = new EventSource(FB + "/salas/" + SALA + ".json");
    function onEv(ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d) return;
      var path = d.path || "/", data = d.data;
      if (path === "/") {                       // instantánea inicial o actualización completa
        if (data && data.state) deliver(data.state);
        if (data && data.evt && !baselineDone) seenEvt[data.evt.id] = 1;   // no repetir eventos viejos
        baselineDone = true;
      } else if (path === "/state" && data) deliver(data);
      else if (path === "/evt" && data) { if (!baselineDone) { baselineDone = true; seenEvt[data.id] = 1; } else deliver(data); }
      else if (path === "/ack" && data) deliver(data);
    }
    es.addEventListener("put", onEv); es.addEventListener("patch", onEv);
  }

  /* ---------- Utilidades ---------- */
  function pathOf(el) {
    if (el.id && document.getElementById(el.id) === el) return "#" + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id && document.getElementById(el.id) === el) { parts.unshift("#" + CSS.escape(el.id)); break; }
      var i = 1, s = el; while ((s = s.previousElementSibling)) i++;
      parts.unshift(el.tagName.toLowerCase() + ":nth-child(" + i + ")");
      el = el.parentElement;
    }
    return parts.join(">");
  }
  function snapshot() {
    var S = window.__sim, out = {};
    if (!S) return out;
    Object.keys(S).forEach(function (k) {
      var v = S[k], t = typeof v;
      if (SKIP_KEYS[k]) return;
      if (v === null || t === "number" || t === "boolean" || t === "string") out[k] = v;
    });
    return out;
  }

  /* ================= PANEL ================= */
  var badge;
  function panelInit() {
    badge = document.createElement("div");
    badge.style.cssText = "position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:60;padding:4px 12px;border-radius:99px;" +
      "font:12px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;background:rgba(0,0,0,.7);" +
      "border:1px solid rgba(255,255,255,.2);color:#e8ecf4;pointer-events:none";
    document.body.appendChild(badge);
    setInterval(drawBadge, 700); drawBadge();

    var pending = null;
    function sendState() { send({ type: "state", page: PAGE, S: snapshot(), ts: Date.now() }); }
    function soon() { clearTimeout(pending); pending = setTimeout(sendState, 120); }

    document.addEventListener("click", function (e) {
      if (!e.isTrusted) return;
      var b = e.target.closest && e.target.closest("button,[data-v]");
      if (!b || b.id === "sound" || b.closest("#xrBtn")) return;
      send({ type: "evt", id: UID + ":" + (++evtN), k: "click", sel: pathOf(b) });
      soon();
    }, true);

    var lastSet = {};
    function onSet(e) {
      if (!e.isTrusted) return;
      var t = e.target; if (!t || !t.tagName || !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.id === "sound") return;
      var sel = pathOf(t), now = Date.now();
      if (e.type === "input" && t.type === "range" && now - (lastSet[sel] || 0) < 90) return;   // limitar sliders
      lastSet[sel] = now;
      send({ type: "evt", id: UID + ":" + (++evtN), k: "set", ev: e.type, sel: sel, value: t.value, checked: !!t.checked });
      soon();
    }
    document.addEventListener("input", onSet, true);
    document.addEventListener("change", onSet, true);

    setInterval(sendState, 1000);
    sendState();
    handlers.push(function (m) {
      if (m.type === "hello") sendState();
      else if (m.type === "ack") lastAck = Date.now();
    });
  }
  function drawBadge() {
    if (!badge) return;
    var ok = Date.now() - lastAck < 6000;
    badge.innerHTML = '<span style="color:' + (ok ? "#5fe3a1" : "#ff8419") + '">●</span> sala ' + SALA +
      " · pantalla cerebro: " + (ok ? "conectada" : "esperando…") + (FB ? " · red" : " · local");
  }

  /* ================= CEREBRO ================= */
  function viewerInit() {
    var st = document.createElement("style");
    st.textContent =
      ".topbar,header,#panel,#dock,#start,#tip,#xrBtn,.foot{display:none!important}" +
      "html,body{cursor:none}" +
      "@media(min-width:761px){canvas#c,canvas{transform:translateX(190px)}}";   // recentra el cerebro (el sitio lo desplaza a la izquierda para dejar sitio al panel)
    document.head.appendChild(st);

    var dot = document.createElement("div");
    dot.style.cssText = "position:fixed;left:8px;bottom:8px;width:8px;height:8px;border-radius:50%;z-index:60;background:#ff8419;opacity:.55;pointer-events:none";
    document.body.appendChild(dot);
    setInterval(function () { dot.style.background = Date.now() - lastRecv < 4000 ? "#5fe3a1" : "#ff8419"; }, 800);

    addEventListener("dblclick", function () {
      var d = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen(); else if (d.requestFullscreen) d.requestFullscreen().catch(function () {});
    });

    var el;
    handlers.push(function (m) {
      if (m.type === "state") {
        if (m.page && m.page !== PAGE) { location.replace(urlFor(m.page)); return; }
        var S = window.__sim; if (!S || !m.S) return;
        Object.keys(m.S).forEach(function (k) { if (!SKIP_KEYS[k]) S[k] = m.S[k]; });
      } else if (m.type === "evt") {
        if (seenEvt[m.id]) return; seenEvt[m.id] = 1;
        try { el = document.querySelector(m.sel); } catch (e) { el = null; }
        if (!el) return;
        if (m.k === "click") el.click();
        else if (m.k === "set") {
          if (el.type === "checkbox" || el.type === "radio") el.checked = !!m.checked; else el.value = m.value;
          el.dispatchEvent(new Event(m.ev || "input", { bubbles: true }));
        }
      }
    });
    function mute() { var S = window.__sim; if (S && "sound" in S) S.sound = false; }
    setInterval(mute, 300);
    setInterval(function () { send({ type: "ack", ts: Date.now() }); }, 2000);
    send({ type: "hello" }); send({ type: "ack", ts: Date.now() });
  }

  listenFirebase();
  if (isPanel) panelInit(); else viewerInit();
})();
