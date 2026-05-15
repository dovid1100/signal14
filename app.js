/* ============================================================
   MARKET PREDICTION V2 — app.js
   All frontend logic. Loaded by index.html.
   ============================================================ */

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const BACKEND_URL = "/api/scan";
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_OUTCOME_AFTER_MS = 60 * 60 * 1000; // 1 hour min before checking outcome

const CATALYST_COLORS = {
  "Earnings Beat": "#00ff88",
  "M&A Deal": "#00d4ff",
  "FDA Approval": "#ff6b35",
  "Contract Win": "#ffd700",
  "Analyst Upgrade": "#a78bfa",
  "Regulatory Win": "#34d399",
  "Short Squeeze": "#f472b6",
  "Guidance Raise": "#4ade80",
  "Clinical Trial": "#f97316",
  "Biotech Catalyst": "#e879f9",
};

const URGENCY = {
  Critical: { color: "#ff2d55", bg: "rgba(255,45,85,0.12)" },
  High: { color: "#ff9500", bg: "rgba(255,149,0,0.10)" },
  Medium: { color: "#ffd60a", bg: "rgba(255,214,10,0.08)" },
};

// ─── STATE ────────────────────────────────────────────────────────────────────
let alerts = [];
let predictions = [];
let activeFilter = "all";
let predFilter = "all";
let activeTab = "signals";
let scanning = false;
let countdown = SCAN_INTERVAL_MS / 1000;
let unread = 0;
let seenKeys = {};
let timerInterval = null;
let accuracyCache = {}; // catalyst type → { hits, total }

// ─── STORAGE ─────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const p = localStorage.getItem("mpv2_predictions");
    predictions = p ? JSON.parse(p) : [];
    const a = localStorage.getItem("mpv2_alerts");
    alerts = a ? JSON.parse(a) : [];
    // Restore seenKeys
    alerts.forEach((al) => (seenKeys[al.ticker + "|" + al.headline] = true));
  } catch (_) {
    predictions = [];
    alerts = [];
  }
  rebuildAccuracyCache();
}

function saveAlerts() {
  try {
    localStorage.setItem("mpv2_alerts", JSON.stringify(alerts.slice(0, 50)));
  } catch (_) {}
}

function savePredictions() {
  try {
    localStorage.setItem("mpv2_predictions", JSON.stringify(predictions));
  } catch (_) {}
}

// ─── ACCURACY CACHE ───────────────────────────────────────────────────────────
function rebuildAccuracyCache() {
  accuracyCache = {};
  predictions.forEach((p) => {
    if (p.outcome !== "hit" && p.outcome !== "miss") return;
    if (!accuracyCache[p.catalystType]) accuracyCache[p.catalystType] = { hits: 0, total: 0 };
    accuracyCache[p.catalystType].total++;
    if (p.outcome === "hit") accuracyCache[p.catalystType].hits++;
  });
}

function getAccuracyForCatalyst(catalystType) {
  const d = accuracyCache[catalystType];
  if (!d || d.total < 3) return null; // need at least 3 data points
  return Math.round((d.hits / d.total) * 100);
}

function getOverallAccuracy() {
  const resolved = predictions.filter((p) => p.outcome === "hit" || p.outcome === "miss");
  if (resolved.length === 0) return null;
  const hits = resolved.filter((p) => p.outcome === "hit").length;
  return Math.round((hits / resolved.length) * 100);
}

// ─── PWA / SERVICE WORKER ─────────────────────────────────────────────────────
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    // Save backend URL to cache so SW can use it for background scans
    if ("caches" in window) {
      const cache = await caches.open("mpv2-v1");
      await cache.put(
        "/config",
        new Response(JSON.stringify({ backendUrl: BACKEND_URL }), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    // Register periodic background sync if supported
    if ("periodicSync" in reg) {
      try {
        await reg.periodicSync.register("market-scan", { minInterval: SCAN_INTERVAL_MS });
      } catch (_) {}
    }
    // Listen for messages from SW (background scan results)
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "NEW_SIGNALS" && Array.isArray(e.data.alerts)) {
        handleFreshAlerts(e.data.alerts);
      }
    });
  } catch (_) {}
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function fireNotification(alert) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(`🚨 ${alert.ticker} +${alert.estimatedUpside}%`, {
      body: alert.headline,
      icon: "/icon-192.png",
      tag: alert.ticker,
      renotify: true,
    });
  } catch (_) {}
  // Also play sound
  playAlertSound();
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch (_) {}
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────
async function runScan() {
  if (scanning) return;
  setScanning(true);
  countdown = SCAN_INTERVAL_MS / 1000;
  log("info", "Initiating scan — fetching movers + confirming catalysts...");

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    log("info", `HTTP ${res.status}`);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 100)}`);
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.marketClosed) {
      log("clear", `⏸ ${data.message || "Market closed"}`);
      countdown = 15 * 60; // slow poll when closed
      renderClosedState();
      return;
    }

    // Log tier info
    const tierLabel = ["", "Free (Yahoo+Claude)", "Polygon.io", "Institutional"][data.tier || 1];
    log("info", `Tier: ${tierLabel} · ${data.moversFound || 0} movers found · ${data.storiesAnalyzed || 0} analyzed`);

    handleFreshAlerts(data.alerts || []);
    updateStatusBar(data);
  } catch (err) {
    log("error", `Scan failed: ${err.message || String(err)}`);
  } finally {
    setScanning(false);
  }
}

function handleFreshAlerts(incoming) {
  const fresh = incoming.filter((a) => {
    if (!a?.ticker) return false;
    const k = a.ticker + "|" + a.headline;
    if (seenKeys[k]) return false;
    seenKeys[k] = true;
    return true;
  }).map((a) => ({
    ...a,
    id: `${a.ticker}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    isNew: true,
  }));

  if (fresh.length === 0) {
    log("clear", "No new qualifying signals this scan");
    return;
  }

  alerts = fresh.concat(alerts).slice(0, 50);
  unread += fresh.length;
  saveAlerts();

  // Log to prediction tracker
  fresh.forEach((a) => logPrediction(a));

  // Notify for Critical/High
  const important = fresh.filter((a) => a.urgency === "Critical" || a.urgency === "High");
  if (important.length > 0) {
    important.forEach((a) => fireNotification(a));
  }

  // Clear "new" badge after 30s
  setTimeout(() => {
    fresh.forEach((a) => (a.isNew = false));
    renderFeed();
  }, 30000);

  log("found", `✓ ${fresh.length} new signal(s) confirmed`);
  updateStats();
  renderFeed();
  updateBellBadge();

  // Update tab badge
  const tb = document.getElementById("tab-signals-badge");
  if (tb) { tb.textContent = alerts.length; tb.style.display = "inline-block"; }
}

// ─── PREDICTION TRACKER ───────────────────────────────────────────────────────
function logPrediction(alert) {
  if (predictions.some((p) => p.id === alert.id)) return;
  predictions.unshift({
    id: alert.id,
    ticker: alert.ticker,
    company: alert.company || "",
    headline: alert.headline || "",
    catalystType: alert.catalystType || "Unknown",
    urgency: alert.urgency || "Medium",
    confidence: alert.confidence || 0,
    predictedUpside: alert.estimatedUpside || 0,
    priceAtAlert: alert.priceAtAlert || null,
    volumeRatio: alert.volumeRatio || null,
    source: alert.source || null,
    loggedAt: Date.now(),
    outcome: "pending",
    actualMove: null,
    checkedAt: null,
  });
  savePredictions();
  updateTrackerBadge();
}

async function fetchPriceChange(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const proxy = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    const res = await fetch(proxy);
    const data = await res.json();
    const closes = data.chart.result[0].indicators.quote[0].close.filter((v) => v != null);
    if (closes.length < 2) return null;
    const pct = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
    return Math.round(pct * 100) / 100;
  } catch (_) {
    return null;
  }
}

async function checkOutcome(predId) {
  const pred = predictions.find((p) => p.id === predId);
  if (!pred || pred.outcome !== "pending") return;
  pred.outcome = "checking";
  savePredictions();
  if (activeTab === "tracker") renderPredList();

  const pct = await fetchPriceChange(pred.ticker);
  pred.checkedAt = Date.now();
  if (pct === null) {
    pred.outcome = "pending";
    pred.checkedAt = null;
    log("error", `Could not fetch price for ${pred.ticker}`);
  } else {
    pred.actualMove = pct;
    pred.outcome = pct >= 5 ? "hit" : "miss";
    log(
      pred.outcome === "hit" ? "found" : "clear",
      `${pred.ticker} outcome: ${pct >= 0 ? "+" : ""}${pct}% — ${pred.outcome === "hit" ? "✓ HIT" : "✗ MISS"}`
    );
  }
  savePredictions();
  rebuildAccuracyCache();
  updateTrackerBadge();
  if (activeTab === "tracker") { renderPredList(); renderAccuracy(); }
  if (activeTab === "signals") renderFeed(); // re-render to update accuracy scores on cards
}

function autoCheckPending() {
  const now = Date.now();
  predictions.forEach((p) => {
    if (p.outcome !== "pending") return;
    if (now - p.loggedAt < CHECK_OUTCOME_AFTER_MS) return;
    if (p._lastAutoCheck && now - p._lastAutoCheck < 15 * 60 * 1000) return;
    p._lastAutoCheck = now;
    checkOutcome(p.id);
  });
}

// ─── TIMER ────────────────────────────────────────────────────────────────────
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!scanning) {
      countdown--;
      if (countdown <= 0) {
        countdown = SCAN_INTERVAL_MS / 1000;
        runScan();
      }
    }
    renderTimer();
  }, 1000);
}

function renderTimer() {
  const m = Math.floor(countdown / 60);
  const s = countdown % 60;
  const txt = document.getElementById("timer-txt");
  const fill = document.getElementById("timer-fill");
  if (txt) txt.textContent = scanning ? "LIVE" : `${m}:${s < 10 ? "0" : ""}${s}`;
  if (fill) {
    const pct = scanning ? 100 : ((SCAN_INTERVAL_MS / 1000 - countdown) / (SCAN_INTERVAL_MS / 1000)) * 100;
    fill.style.width = `${pct}%`;
  }
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function setScanning(on) {
  scanning = on;
  const dot = document.getElementById("dot");
  const btn = document.getElementById("scan-btn");
  if (dot) dot.className = `dot${on ? " on" : ""}`;
  if (btn) { btn.textContent = on ? "SCANNING..." : "SCAN NOW"; btn.disabled = on; }
  if (on && alerts.length === 0) renderScanningState();
}

function log(type, msg) {
  const section = document.getElementById("log-section");
  const rows = document.getElementById("log-rows");
  if (!section || !rows) return;
  section.style.display = "block";
  const row = document.createElement("div");
  row.className = "log-row";
  row.innerHTML = `<span class="lt">${new Date().toLocaleTimeString()}</span><span class="ls">›</span><span class="lm ${type}">${msg}</span>`;
  rows.insertBefore(row, rows.firstChild);
  while (rows.children.length > 20) rows.removeChild(rows.lastChild);
}

function updateStats() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("s-total", alerts.length);
  set("s-crit", alerts.filter((a) => a.urgency === "Critical").length);
  set("s-high", alerts.filter((a) => a.urgency === "High").length);
  set("s-10p", alerts.filter((a) => (a.estimatedUpside || 0) >= 10).length);
}

function updateStatusBar(data) {
  const sb = document.getElementById("status-bar");
  if (!sb) return;
  sb.style.display = "flex";
  const set = (id, val, color) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = val; if (color) el.style.color = color; }
  };
  set("sb-time", new Date().toLocaleTimeString());
  set("sb-analyzed", `${data.storiesAnalyzed || 0} analyzed`);
  const hasAlerts = (data.alerts || []).length > 0;
  set("sb-found", hasAlerts ? `${data.alerts.length} signal(s)` : "no signals", hasAlerts ? "#00ff88" : "#1a3a5c");
}

function updateBellBadge() {
  const badge = document.getElementById("bell-badge");
  if (!badge) return;
  badge.style.display = unread > 0 ? "flex" : "none";
  badge.textContent = unread > 9 ? "9+" : unread;
}

function updateTrackerBadge() {
  const pending = predictions.filter((p) => p.outcome === "pending").length;
  const badge = document.getElementById("tab-tracker-badge");
  if (!badge) return;
  badge.style.display = pending > 0 ? "inline-block" : "none";
  badge.textContent = pending;
}

// ─── FEED RENDERING ───────────────────────────────────────────────────────────
function getFiltered() {
  if (activeFilter === "critical") return alerts.filter((a) => a.urgency === "Critical");
  if (activeFilter === "high") return alerts.filter((a) => a.urgency === "Critical" || a.urgency === "High");
  if (activeFilter === "10plus") return alerts.filter((a) => (a.estimatedUpside || 0) >= 10);
  return alerts;
}

function renderScanningState() {
  const feed = document.getElementById("feed");
  if (!feed) return;
  feed.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon pulse">📡</div>
      <div class="empty-title scanning-text">SCANNING LIVE MARKETS</div>
      <div class="empty-sub">Finding movers · Confirming catalysts · Two-pass verification</div>
    </div>`;
}

function renderClosedState() {
  if (alerts.length > 0) return;
  const feed = document.getElementById("feed");
  if (!feed) return;
  feed.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🌙</div>
      <div class="empty-title">MARKET CLOSED</div>
      <div class="empty-sub">Scanning resumes at 9:00 AM ET · Mon–Fri</div>
    </div>`;
}

function renderFeed() {
  const feed = document.getElementById("feed");
  if (!feed) return;
  const filtered = getFiltered();
  const fcount = document.getElementById("fcount");
  if (fcount) fcount.textContent = `${filtered.length} RESULT${filtered.length !== 1 ? "S" : ""}`;

  if (alerts.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <div class="empty-title">AWAITING SIGNALS</div>
        <div class="empty-sub">Next scan in ${Math.ceil(countdown / 60)} min · Two-pass verification active</div>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-title">NO RESULTS FOR THIS FILTER</div></div>`;
    return;
  }

  feed.innerHTML = filtered.map((a) => buildAlertCard(a)).join("");
}

function buildAlertCard(a) {
  const urg = URGENCY[a.urgency] || URGENCY.Medium;
  const cc = CATALYST_COLORS[a.catalystType] || "#334155";
  const conf = a.confidence || 0;
  const confColor = conf >= 80 ? "#00ff88" : conf >= 65 ? "#ffd60a" : "#ff9500";

  // Live accuracy score for this catalyst type
  const accPct = getAccuracyForCatalyst(a.catalystType);
  const accHtml = accPct !== null
    ? `<span class="acc-badge" style="color:${accPct >= 65 ? "#00ff88" : accPct >= 50 ? "#ffd60a" : "#ff2d55"}">⚡ ${accPct}% hist. accuracy</span>`
    : "";

  // Volume and price change badges
  const volHtml = a.volumeRatio ? `<span class="meta-chip">📊 ${a.volumeRatio}x vol</span>` : "";
  const chgHtml = a.currentChange ? `<span class="meta-chip" style="color:${a.currentChange >= 0 ? "#00ff88" : "#ff2d55"}">${a.currentChange >= 0 ? "+" : ""}${a.currentChange}%</span>` : "";

  const srcHtml = a.source
    ? `<div class="source-block">
        <div class="source-lbl">SOURCE</div>
        <div class="source-name">${a.sourceName || "Unknown"}${a.newsTime ? ` · ${a.newsTime}` : ""}</div>
        <a class="source-link" href="${a.source}" target="_blank" rel="noopener">🔗 ${a.source}</a>
      </div>`
    : "";

  return `
    <div class="acard${a.urgency === "Critical" ? " critical-pulse" : ""}${a.isNew ? " slide-in" : ""}"
         style="border-left-color:${urg.color}"
         onclick="toggleCard('${a.id}')">
      <div class="card-main">
        <div class="card-row">
          <div class="ticker-box">
            <div class="ticker-sym">${a.ticker}</div>
            <div class="ticker-co">${(a.company || "").split(" ").slice(0, 2).join(" ")}</div>
            ${a.priceAtAlert ? `<div class="ticker-price">$${a.priceAtAlert}</div>` : ""}
          </div>
          <div class="card-mid">
            <div class="badge-row">
              ${a.isNew ? '<span class="badge-new">NEW</span>' : ""}
              <span class="badge-urg" style="color:${urg.color};border-color:${urg.color};background:${urg.bg}">${(a.urgency || "").toUpperCase()}</span>
              <span class="badge-cat" style="color:${cc};border-color:${cc}44;background:${cc}11">${a.catalystType || ""}</span>
              <span class="badge-time">⏱ ${a.timeframe || ""}</span>
            </div>
            <div class="card-headline">${a.headline || ""}</div>
            <div class="card-chips">${volHtml}${chgHtml}${accHtml}</div>
          </div>
          <div class="upside-box">
            <div class="upside-num">+${a.estimatedUpside || 0}%</div>
            <div class="upside-lbl">EST UPSIDE</div>
          </div>
        </div>
        <div class="conf-row">
          <div class="conf-track"><div class="conf-fill" style="width:${conf}%;background:${confColor}"></div></div>
          <span class="conf-lbl">${conf}% CONFIDENCE</span>
          <span class="card-arrow" id="arrow-${a.id}">▼</span>
        </div>
      </div>
      <div class="card-detail" id="detail-${a.id}" onclick="event.stopPropagation()">
        <div class="detail-section">
          <div class="detail-lbl">WHAT HAPPENED</div>
          <div class="detail-txt">${a.summary || ""}</div>
        </div>
        <div class="detail-reason" style="border-left-color:${cc}">
          <div class="detail-lbl">WHY IT CONTINUES TODAY</div>
          <div class="detail-txt">${a.reasoning || ""}</div>
        </div>
        <div class="detail-meta">
          <span>TICKER <b>${a.ticker}</b></span>
          <span>DETECTED <b>${a.ts ? new Date(a.ts).toLocaleTimeString() : ""}</b></span>
          ${a.volumeRatio ? `<span>VOLUME <b>${a.volumeRatio}x avg</b></span>` : ""}
        </div>
        ${srcHtml}
      </div>
    </div>`;
}

function toggleCard(id) {
  const detail = document.getElementById(`detail-${id}`);
  const arrow = document.getElementById(`arrow-${id}`);
  if (!detail) return;
  const open = detail.classList.toggle("open");
  if (arrow) arrow.textContent = open ? "▲" : "▼";
}

function setFilter(f) {
  activeFilter = f;
  ["all", "crit", "high", "10p"].forEach((x) => {
    const el = document.getElementById(`f-${x}`);
    if (el) el.classList.remove("on");
  });
  const map = { all: "f-all", critical: "f-crit", high: "f-high", "10plus": "f-10p" };
  const target = document.getElementById(map[f]);
  if (target) target.classList.add("on");
  renderFeed();
}

// ─── TRACKER RENDERING ────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  ["signals", "tracker"].forEach((t) => {
    const page = document.getElementById(`page-${t}`);
    const ntab = document.getElementById(`tab-${t}`);
    if (page) page.classList.toggle("on", t === tab);
    if (ntab) ntab.classList.toggle("on", t === tab);
  });
  if (tab === "tracker") { renderAccuracy(); renderPredList(); }
}

function setPredFilter(f) {
  predFilter = f;
  ["all", "pending", "hit", "miss"].forEach((x) => {
    const el = document.getElementById(`pf-${x}`);
    if (el) el.classList.toggle("on", x === f);
  });
  renderPredList();
}

function getFilteredPreds() {
  if (predFilter === "pending") return predictions.filter((p) => p.outcome === "pending" || p.outcome === "checking");
  if (predFilter === "hit") return predictions.filter((p) => p.outcome === "hit");
  if (predFilter === "miss") return predictions.filter((p) => p.outcome === "miss");
  return predictions;
}

function formatAge(ms) {
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function renderPredList() {
  const list = document.getElementById("pred-list");
  if (!list) return;
  const filtered = getFilteredPreds();
  const countEl = document.getElementById("pred-count");
  if (countEl) countEl.textContent = `${filtered.length} RESULT${filtered.length !== 1 ? "S" : ""}`;

  if (predictions.length === 0) {
    list.innerHTML = `<div class="trk-empty"><div class="trk-empty-icon">📊</div><div class="trk-empty-title">NO PREDICTIONS YET</div><div class="trk-empty-sub">Every signal is auto-logged here when it fires</div></div>`;
    return;
  }
  if (filtered.length === 0) {
    list.innerHTML = `<div class="trk-empty"><div class="trk-empty-title">NO ${predFilter.toUpperCase()} PREDICTIONS</div></div>`;
    return;
  }

  const now = Date.now();
  list.innerHTML = filtered.map((pred) => {
    const cc = CATALYST_COLORS[pred.catalystType] || "#334155";
    const confColor = pred.confidence >= 80 ? "#00ff88" : pred.confidence >= 65 ? "#ffd60a" : "#ff9500";
    const age = now - pred.loggedAt;
    const canCheck = pred.outcome === "pending" && age >= CHECK_OUTCOME_AFTER_MS;

    const badge =
      pred.outcome === "hit" ? `<span class="outcome-badge hit">✅ HIT</span>` :
      pred.outcome === "miss" ? `<span class="outcome-badge miss">❌ MISS</span>` :
      pred.outcome === "checking" ? `<span class="outcome-badge checking">⏳ CHECKING</span>` :
      `<span class="outcome-badge pending">⏳ PENDING</span>`;

    const actualHtml = pred.actualMove !== null
      ? `<div class="pred-num"><div class="pred-num-lbl">ACTUAL</div><div class="pred-num-val ${pred.actualMove >= 5 ? "pos" : pred.actualMove >= 0 ? "neutral" : "neg"}">${pred.actualMove >= 0 ? "+" : ""}${pred.actualMove}%</div></div>`
      : "";

    const checkBtn = pred.outcome === "pending"
      ? `<button class="check-btn"${canCheck ? "" : ' disabled title="Available after 1 hour"'} onclick="event.stopPropagation();checkOutcome('${pred.id}')">CHECK OUTCOME</button>`
      : "";

    const progHtml = pred.actualMove !== null ? `
      <div class="pred-progress">
        <div class="prog-row"><span class="prog-lbl">PREDICTED</span><div class="prog-track"><div class="prog-fill" style="width:${Math.min(pred.predictedUpside * 4, 100)}%;background:#00ff88"></div></div><span class="prog-val">+${pred.predictedUpside}%</span></div>
        <div class="prog-row"><span class="prog-lbl">ACTUAL</span><div class="prog-track"><div class="prog-fill" style="width:${Math.min(Math.abs(pred.actualMove) * 4, 100)}%;background:${pred.actualMove >= 5 ? "#00ff88" : pred.actualMove >= 0 ? "#ffd60a" : "#ff2d55"}"></div></div><span class="prog-val">${pred.actualMove >= 0 ? "+" : ""}${pred.actualMove}%</span></div>
      </div>` : "";

    const srcHtml = pred.source
      ? `<a class="pred-source-link" href="${pred.source}" target="_blank" rel="noopener">🔗 Original source</a>`
      : "";

    return `
      <div class="pred-card outcome-${pred.outcome}">
        <div class="pred-body">
          <div class="pred-top">
            <div class="pred-ticker">${pred.ticker}</div>
            <div class="pred-info">
              <div class="pred-headline">${pred.headline}</div>
              <div class="pred-meta">
                <span class="pmeta" style="color:${cc}">${pred.catalystType}</span>
                <span class="pmeta">CONF <b style="color:${confColor}">${pred.confidence}%</b></span>
                <span class="pmeta">AGE <b>${formatAge(age)}</b></span>
              </div>
            </div>
            <div class="pred-outcome-box">${badge}</div>
          </div>
          <div class="pred-numbers">
            <div class="pred-num"><div class="pred-num-lbl">PREDICTED</div><div class="pred-num-val pos">+${pred.predictedUpside}%</div></div>
            ${actualHtml}
            ${checkBtn}
          </div>
          ${progHtml}
          ${srcHtml}
        </div>
      </div>`;
  }).join("");
}

function renderAccuracy() {
  const resolved = predictions.filter((p) => p.outcome === "hit" || p.outcome === "miss");
  const hits = resolved.filter((p) => p.outcome === "hit");

  const set = (id, val, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (color) el.style.color = color;
  };

  const overall = getOverallAccuracy();
  if (overall !== null) {
    set("acc-overall", `${overall}%`, overall >= 65 ? "#00ff88" : overall >= 50 ? "#ffd60a" : "#ff2d55");
    set("acc-overall-sub", `${hits.length} of ${resolved.length} signals`);
  } else {
    set("acc-overall", "—", "#cbd5e1");
    set("acc-overall-sub", "need 3+ outcomes");
  }

  set("acc-total", predictions.length);
  set("acc-total-sub", `${predictions.filter((p) => p.outcome === "pending").length} pending`);

  const avgPred = predictions.length > 0
    ? Math.round(predictions.reduce((s, p) => s + p.predictedUpside, 0) / predictions.length * 10) / 10
    : null;
  set("acc-avg-pred", avgPred !== null ? `+${avgPred}%` : "—");

  const actVals = resolved.filter((p) => p.actualMove !== null).map((p) => p.actualMove);
  if (actVals.length > 0) {
    const avg = Math.round(actVals.reduce((s, v) => s + v, 0) / actVals.length * 10) / 10;
    set("acc-avg-actual", `${avg >= 0 ? "+" : ""}${avg}%`, avg >= 5 ? "#00ff88" : avg >= 0 ? "#ffd60a" : "#ff2d55");
  } else {
    set("acc-avg-actual", "—", "#cbd5e1");
  }

  renderBreakdown();
}

function renderBreakdown() {
  const catalystEl = document.getElementById("bk-catalyst");
  const confEl = document.getElementById("bk-confidence");
  const resolved = predictions.filter((p) => p.outcome === "hit" || p.outcome === "miss");
  if (resolved.length === 0) return;

  // By catalyst
  const byC = {};
  resolved.forEach((p) => {
    if (!byC[p.catalystType]) byC[p.catalystType] = { hits: 0, total: 0 };
    byC[p.catalystType].total++;
    if (p.outcome === "hit") byC[p.catalystType].hits++;
  });

  if (catalystEl) {
    const keys = Object.keys(byC).sort((a, b) => byC[b].hits / byC[b].total - byC[a].hits / byC[a].total);
    catalystEl.innerHTML = keys.map((k) => {
      const g = byC[k]; const pct = Math.round(g.hits / g.total * 100); const c = CATALYST_COLORS[k] || "#334155";
      return `<div class="bk-row"><div class="bk-name" style="color:${c}">${k}</div><div class="bk-bar-wrap"><div class="bk-bar-fill" style="width:${pct}%;background:${c}"></div></div><div class="bk-pct" style="color:${c}">${pct}%</div><div class="bk-n">(${g.hits}/${g.total})</div></div>`;
    }).join("");
  }

  // By confidence tier
  const byConf = { "High 80%+": { hits: 0, total: 0 }, "Mid 65-79%": { hits: 0, total: 0 }, "Low <65%": { hits: 0, total: 0 } };
  resolved.forEach((p) => {
    const tier = p.confidence >= 80 ? "High 80%+" : p.confidence >= 65 ? "Mid 65-79%" : "Low <65%";
    byConf[tier].total++;
    if (p.outcome === "hit") byConf[tier].hits++;
  });
  const tierColors = { "High 80%+": "#00ff88", "Mid 65-79%": "#ffd60a", "Low <65%": "#ff9500" };
  if (confEl) {
    confEl.innerHTML = Object.keys(byConf).filter((k) => byConf[k].total > 0).map((k) => {
      const g = byConf[k]; const pct = Math.round(g.hits / g.total * 100); const c = tierColors[k];
      return `<div class="bk-row"><div class="bk-name" style="color:${c}">${k}</div><div class="bk-bar-wrap"><div class="bk-bar-fill" style="width:${pct}%;background:${c}"></div></div><div class="bk-pct" style="color:${c}">${pct}%</div><div class="bk-n">(${g.hits}/${g.total})</div></div>`;
    }).join("") || `<div style="font-size:8px;color:#1a3a5c;padding:10px 0;text-align:center">No data yet</div>`;
  }
}

function clearAllPredictions() {
  if (!confirm("Clear all prediction history? Cannot be undone.")) return;
  predictions = [];
  savePredictions();
  rebuildAccuracyCache();
  renderPredList();
  renderAccuracy();
  updateTrackerBadge();
  renderFeed(); // refresh accuracy badges on signal cards
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  loadState();
  updateStats();
  updateBellBadge();
  updateTrackerBadge();
  renderFeed();
  renderAccuracy();
  renderPredList();
  startTimer();

  await registerSW();
  await requestNotificationPermission();

  // Auto-check pending predictions every 5 min
  setInterval(autoCheckPending, 5 * 60 * 1000);
  // Re-render pred list ages every 30s
  setInterval(() => { if (activeTab === "tracker") renderPredList(); }, 30 * 1000);

  // Event listeners
  document.getElementById("scan-btn")?.addEventListener("click", runScan);
  document.getElementById("bell")?.addEventListener("click", () => { unread = 0; updateBellBadge(); });
  document.getElementById("f-all")?.addEventListener("click", () => setFilter("all"));
  document.getElementById("f-crit")?.addEventListener("click", () => setFilter("critical"));
  document.getElementById("f-high")?.addEventListener("click", () => setFilter("high"));
  document.getElementById("f-10p")?.addEventListener("click", () => setFilter("10plus"));

  // Kick off first scan
  runScan();
}

// Expose globals needed by inline onclick handlers
window.toggleCard = toggleCard;
window.switchTab = switchTab;
window.setPredFilter = setPredFilter;
window.checkOutcome = checkOutcome;
window.clearAllPredictions = clearAllPredictions;

document.addEventListener("DOMContentLoaded", init);
