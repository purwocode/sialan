import { NextResponse } from "next/server";
import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";

export const runtime = "nodejs";

/* ===============================
   ENDPOINTS
=============================== */
const MELOLO_EP = "https://melolo-api-azure.vercel.app/api/melolo/detail";
const MELOLO_STREAM = "https://melolo-api-azure.vercel.app/api/melolo/stream";

const NETSHORT_EP = "https://netshort.sansekai.my.id/api/netshort/allepisode";
const DRAMABOX_EP = "https://dramabox.sansekai.my.id/api/dramabox/allepisode";

// ✅ FlickReels Episode Detail + All Episode
const FLICK_EP =
  "https://api.sansekai.my.id/api/flickreels/detailAndAllEpisode";

/* ===============================
   RTDB (REST)
   /proxies/proxies/{id} => { alive, lastChecked, proxy: "IP:PORT" }
=============================== */
const RTDB_BASE_URL =
  "https://proxy-cf6c5-default-rtdb.asia-southeast1.firebasedatabase.app";
const RTDB_PROXY_PATH = "proxies/proxies";

/* ===============================
   HEADERS
=============================== */
const headers = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// Flick headers (minimal sesuai curl: accept */*)
const FLICK_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  referer: "https://api.sansekai.my.id/",
  connection: "keep-alive",
};

/* ===============================
   RTDB PROXY FETCH + CACHE
=============================== */
let proxyCache = { list: [], ts: 0 };
const CACHE_MS = 30_000;

function rtdbUrl(path) {
  return `${RTDB_BASE_URL}/${path}.json`;
}

function pickProxy(list) {
  if (!list?.length) return null;
  const slice = list.slice(0, 20);
  return slice[Math.floor(Math.random() * slice.length)];
}

async function getAliveProxy(debugLog) {
  const now = Date.now();

  if (proxyCache.list.length && now - proxyCache.ts < CACHE_MS) {
    const picked = pickProxy(proxyCache.list);
    debugLog?.push({
      step: "proxy_cache_hit",
      count: proxyCache.list.length,
      picked,
    });
    return picked;
  }

  const res = await fetch(rtdbUrl(RTDB_PROXY_PATH), { cache: "no-store" });
  if (!res.ok) {
    debugLog?.push({ step: "proxy_rtdb_fetch_failed", status: res.status });
    return null;
  }

  const data = await res.json();
  if (!data || typeof data !== "object") {
    debugLog?.push({ step: "proxy_rtdb_invalid_data" });
    return null;
  }

  const list = Object.values(data)
    .filter(Boolean)
    .filter(
      (p) =>
        p.alive === true &&
        typeof p.proxy === "string" &&
        p.proxy.includes(":")
    )
    .sort((a, b) => (b.lastChecked || 0) - (a.lastChecked || 0))
    .map((p) => p.proxy.trim());

  proxyCache = { list, ts: now };

  debugLog?.push({
    step: "proxy_rtdb_loaded",
    totalAlive: list.length,
    top5: list.slice(0, 5),
  });

  return pickProxy(list);
}

/* ===============================
   SOCKS5 FETCH (Flick only)
   - fallback direct kalau socks gagal
=============================== */
async function fetchFlickViaSocks(url, debug = false, debugLog = []) {
  const meta = {
    url,
    mode: "unknown", // socks5 | direct
    proxy: null,
    proxyUrl: null,
    error: null,
  };

  const proxy = await getAliveProxy(debug ? debugLog : null);
  meta.proxy = proxy;
  meta.proxyUrl = proxy ? `socks5://${proxy}` : null;

  if (debug) {
    debugLog.push({
      step: "flick_proxy_selected",
      proxy: meta.proxy,
      proxyUrl: meta.proxyUrl,
    });
  }

  if (meta.proxyUrl) {
    try {
      const agent = new SocksProxyAgent(meta.proxyUrl);

      const { data } = await axios.get(url, {
        headers: FLICK_HEADERS,
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 15000,
        validateStatus: (s) => s >= 200 && s < 300,
      });

      meta.mode = "socks5";
      if (debug) debugLog.push({ step: "flick_socks_success" });
      return { json: data ?? null, meta };
    } catch (err) {
      meta.error = err?.message || String(err);
      if (debug) debugLog.push({ step: "flick_socks_failed", error: meta.error });
      console.error("FLICK SOCKS FAILED:", meta.proxyUrl, meta.error);
    }
  } else {
    if (debug) debugLog.push({ step: "flick_no_proxy_available" });
  }

  // fallback direct
  try {
    const res = await fetch(url, { headers: FLICK_HEADERS, cache: "no-store" });
    if (!res.ok) {
      meta.mode = "direct";
      meta.error = `direct_http_${res.status}`;
      if (debug) debugLog.push({ step: "flick_direct_failed", status: res.status });
      return { json: null, meta };
    }
    const json = await res.json();
    meta.mode = "direct";
    if (debug) debugLog.push({ step: "flick_direct_success" });
    return { json, meta };
  } catch (err) {
    meta.mode = "direct";
    meta.error = err?.message || String(err);
    if (debug) debugLog.push({ step: "flick_direct_exception", error: meta.error });
    return { json: null, meta };
  }
}

/* ===============================
   MELOLO UTIL
=============================== */
async function resolveMeloloMainUrl(vid) {
  try {
    const res = await fetch(`${MELOLO_STREAM}/${vid}`, {
      headers,
      cache: "no-store",
    });
    const json = await res.json();
    return json?.data?.main_url || null;
  } catch {
    return null;
  }
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const debug = searchParams.get("debug") === "1";

  if (!id) {
    return NextResponse.json({ error: "id wajib diisi" }, { status: 400 });
  }

  const debugLog = [];
  const flickDebug = { meta: null };

  try {
    /* ===============================
       0️⃣ FLICKREELS (Coba dulu)
       GET /api/flickreels/detailAndAllEpisode?id=487
    =============================== */
    try {
      const flickUrl = `${FLICK_EP}?id=${encodeURIComponent(id)}`;
      const flickRes = await fetchFlickViaSocks(flickUrl, debug, debugLog);
      const flickJson = flickRes?.json;

      if (debug) flickDebug.meta = flickRes?.meta;

      // Response contoh yang kamu kirim: { drama: {...}, episodes: [...] }
      if (flickJson?.drama && Array.isArray(flickJson?.episodes)) {
        const dra
