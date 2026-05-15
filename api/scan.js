export const config = { runtime: "edge" };

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// ─── TIER CONFIG ─────────────────────────────────────────────────────────────
// Phase 1: Free (Yahoo Finance + Claude web search)
// Phase 2: Set POLYGON_API_KEY env var to unlock real-time data
// Phase 3: Set UNUSUAL_WHALES_KEY + BENZINGA_KEY for institutional grade
const TIER = (() => {
  if (typeof process !== "undefined") {
    if (process.env.UNUSUAL_WHALES_KEY && process.env.BENZINGA_KEY) return 3;
    if (process.env.POLYGON_API_KEY) return 2;
  }
  return 1;
})();

// ─── MARKET HOURS ─────────────────────────────────────────────────────────────
function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 && mins < 20 * 60; // 9:00 AM to 8:00 PM ET
}

function getETTime() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

// ─── PHASE 1: FREE DATA SOURCES ───────────────────────────────────────────────
// Fetch Yahoo Finance pre-market and intraday movers
async function fetchYahooMovers() {
  const movers = [];

  const urls = [
    // Most active
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=25",
    // Day gainers
    "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=25",
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const quotes = data?.finance?.result?.[0]?.quotes || [];
      for (const q of quotes) {
        if (!q.symbol || q.quoteType === "CRYPTOCURRENCY") continue;
        const changePercent = q.regularMarketChangePercent || 0;
        const volume = q.regularMarketVolume || 0;
        const avgVolume = q.averageDailyVolume3Month || 1;
        const volumeRatio = volume / avgVolume;
        // Only include if moving 2%+ or volume is 2x+
        if (changePercent >= 2 || volumeRatio >= 2) {
          movers.push({
            ticker: q.symbol,
            company: q.shortName || q.longName || q.symbol,
            price: q.regularMarketPrice || 0,
            changePercent: Math.round(changePercent * 100) / 100,
            volume,
            avgVolume,
            volumeRatio: Math.round(volumeRatio * 10) / 10,
            marketCap: q.marketCap || 0,
          });
        }
      }
    } catch (_) {
      // continue to next source
    }
  }

  // Deduplicate by ticker
  const seen = new Set();
  return movers.filter((m) => {
    if (seen.has(m.ticker)) return false;
    seen.add(m.ticker);
    return true;
  });
}

// ─── PHASE 2: POLYGON DATA (stub — activated by env var) ─────────────────────
async function fetchPolygonMovers(apiKey) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.tickers || []).map((t) => ({
      ticker: t.ticker,
      company: t.ticker,
      price: t.day?.c || 0,
      changePercent: Math.round((t.todaysChangePerc || 0) * 100) / 100,
      volume: t.day?.v || 0,
      avgVolume: t.prevDay?.v || 1,
      volumeRatio: Math.round(((t.day?.v || 0) / (t.prevDay?.v || 1)) * 10) / 10,
      marketCap: 0,
    }));
  } catch (_) {
    return [];
  }
}

// ─── BUILD CLAUDE CONFIRMATION PROMPT ────────────────────────────────────────
function buildConfirmationPrompt(movers) {
  const tickerList = movers
    .map(
      (m) =>
        `${m.ticker} (${m.company}) — price $${m.price}, up ${m.changePercent}%, volume ${m.volumeRatio}x average`
    )
    .join("\n");

  return `You are an elite stock market analyst. The following US stocks are showing unusual price or volume movement RIGHT NOW:

${tickerList}

For EACH ticker above, search the web to find if there is a HARD CATALYST published in the last 24 hours explaining this move. Hard catalysts only:
- FDA approval, drug trial result, IND approval, Fast Track designation
- Earnings beat with EPS surprise >10%
- Raised full-year guidance
- M&A acquisition announced at a premium
- Major contract win or government contract
- Analyst upgrade with significant price target increase
- SEC 8-K filing with material event
- Short squeeze setup — confirmed high short interest >20% with positive catalyst
- Uplisting to NYSE or NASDAQ

STRICT RULES:
1. Only include a ticker if you find a REAL, SPECIFIC news article or SEC filing published in the last 24 hours
2. Every alert MUST have a real source URL — no placeholder URLs
3. If you cannot find a hard catalyst for a ticker, DO NOT include it
4. estimatedUpside must be your honest assessment — do not inflate
5. confidence max 70 for stocks under $5
6. Only return alerts where you are genuinely confident the move will continue 5%+ today

Return ONLY a raw JSON object, no markdown, no explanation:
{
  "alerts": [
    {
      "ticker": "AAPL",
      "company": "Apple Inc",
      "headline": "Max 10 word headline",
      "estimatedUpside": 8,
      "catalystType": "Earnings Beat",
      "urgency": "Critical",
      "timeframe": "hours",
      "summary": "2-3 sentences explaining what happened.",
      "reasoning": "Why this specifically will cause 5%+ continuation today.",
      "confidence": 82,
      "source": "https://exact-url-to-article.com",
      "sourceName": "Reuters",
      "newsTime": "Today at 9:45 AM ET",
      "priceAtAlert": 185.50,
      "volumeRatio": 3.2,
      "currentChange": 4.2
    }
  ],
  "storiesAnalyzed": 20
}

catalystType must be one of: Earnings Beat, M&A Deal, FDA Approval, Contract Win, Analyst Upgrade, Regulatory Win, Short Squeeze, Guidance Raise, Clinical Trial, Biotech Catalyst
urgency must be one of: Critical, High, Medium
timeframe must be one of: hours, days, weeks

If no tickers have confirmed hard catalysts: {"alerts":[],"storiesAnalyzed":${movers.length}}`;
}

// ─── VALIDATE ALERTS ─────────────────────────────────────────────────────────
function validateAlerts(alerts) {
  if (!Array.isArray(alerts)) return [];
  return alerts.filter((a) => {
    if (!a || typeof a.ticker !== "string" || !a.ticker.trim()) return false;
    if (!a.headline || !a.summary || !a.reasoning) return false;
    if (!a.source || !String(a.source).toLowerCase().startsWith("http")) return false;
    const src = a.source.toLowerCase();
    if (
      src.includes("example.com") ||
      src.includes("url-here") ||
      src.includes("placeholder") ||
      src.includes("exact-url")
    )
      return false;
    if (isNaN(Number(a.estimatedUpside)) || Number(a.estimatedUpside) < 5) return false;
    if (!["Critical", "High", "Medium"].includes(a.urgency)) return false;
    if (
      ![
        "Earnings Beat","M&A Deal","FDA Approval","Contract Win",
        "Analyst Upgrade","Regulatory Win","Short Squeeze","Guidance Raise",
        "Clinical Trial","Biotech Catalyst",
      ].includes(a.catalystType)
    )
      return false;
    return true;
  });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  if (!isMarketHours()) {
    const et = getETTime();
    return new Response(
      JSON.stringify({
        marketClosed: true,
        alerts: [],
        storiesAnalyzed: 0,
        tier: TIER,
        message: `Scanning active 9:00 AM–8:00 PM ET Mon–Fri. Current ET: ${et.toLocaleTimeString("en-US")}`,
      }),
      { status: 200, headers: cors }
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured", alerts: [], storiesAnalyzed: 0 }),
      { status: 500, headers: cors }
    );

  try {
    // ── PASS 1: Get movers from data source ──────────────────────────────────
    let movers = [];
    if (TIER >= 2 && process.env.POLYGON_API_KEY) {
      movers = await fetchPolygonMovers(process.env.POLYGON_API_KEY);
    } else {
      movers = await fetchYahooMovers();
    }

    // If no movers found (market just opened, data unavailable), fall back to
    // asking Claude to find movers itself via web search
    const prompt = movers.length > 0
      ? buildConfirmationPrompt(movers)
      : `You are an elite stock market analyst. Search the web RIGHT NOW for US stocks showing unusual movement today — price up 3%+ or volume 3x+ average — then confirm which ones have a hard catalyst (FDA approval, earnings beat, M&A, major contract, short squeeze, 8-K filing). Only return alerts with a real source URL and genuine 5%+ continuation potential today.

Return ONLY raw JSON:
{"alerts":[{"ticker":"","company":"","headline":"","estimatedUpside":0,"catalystType":"Earnings Beat","urgency":"High","timeframe":"hours","summary":"","reasoning":"","confidence":0,"source":"https://","sourceName":"","newsTime":"","priceAtAlert":0,"volumeRatio":0,"currentChange":0}],"storiesAnalyzed":0}

catalystType: Earnings Beat, M&A Deal, FDA Approval, Contract Win, Analyst Upgrade, Regulatory Win, Short Squeeze, Guidance Raise, Clinical Trial, Biotech Catalyst
urgency: Critical, High, Medium — timeframe: hours, days, weeks
Rules: real URLs only, estimatedUpside>=5, confidence max 70 for stocks under $5. If nothing: {"alerts":[],"storiesAnalyzed":0}`;

    // ── PASS 2: Claude confirms catalysts ────────────────────────────────────
    const claudeRes = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      return new Response(
        JSON.stringify({ error: `Anthropic error ${claudeRes.status}: ${t.slice(0, 200)}`, alerts: [], storiesAnalyzed: 0 }),
        { status: 500, headers: cors }
      );
    }

    const claudeData = await claudeRes.json();
    const text = (claudeData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    let parsed = { alerts: [], storiesAnalyzed: 0 };
    try {
      const m = text.replace(/```[\w]*\n?/g, "").match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (_) {}

    // Merge Yahoo mover data into alerts for richer frontend display
    const moverMap = {};
    movers.forEach((m) => (moverMap[m.ticker] = m));

    const validated = validateAlerts(parsed.alerts || []).map((a) => {
      const mover = moverMap[a.ticker];
      if (mover) {
        a.priceAtAlert = a.priceAtAlert || mover.price;
        a.volumeRatio = a.volumeRatio || mover.volumeRatio;
        a.currentChange = a.currentChange || mover.changePercent;
        a.marketCap = mover.marketCap;
      }
      return a;
    });

    // Sort: Critical first, then by confidence desc
    validated.sort((a, b) => {
      const ord = { Critical: 0, High: 1, Medium: 2 };
      const d = (ord[a.urgency] ?? 2) - (ord[b.urgency] ?? 2);
      return d !== 0 ? d : (b.confidence || 0) - (a.confidence || 0);
    });

    return new Response(
      JSON.stringify({
        alerts: validated,
        storiesAnalyzed: parsed.storiesAnalyzed || movers.length,
        moversFound: movers.length,
        tier: TIER,
      }),
      { status: 200, headers: cors }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || String(err), alerts: [], storiesAnalyzed: 0, tier: TIER }),
      { status: 500, headers: cors }
    );
  }
}
