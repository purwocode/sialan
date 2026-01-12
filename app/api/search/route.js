import { NextResponse } from "next/server";
import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";

export const runtime = "nodejs";

/* ===============================
   API ENDPOINTS
=============================== */
const DRAMABOX_SEARCH = "https://dramabox.sansekai.my.id/api/dramabox/search";
const NETSHORT_SEARCH = "https://netshort.sansekai.my.id/api/netshort/search";
const MELOLO_SEARCH = "https://melolo-api-azure.vercel.app/api/melolo/search";

// ✅ FlickReels Search
const FLICK_SEARCH = "https://api.sansekai.my.id/api/flickreels/search";

/* ===============================
   RTDB (REST) - ✅ FIXED PATH + AUTH
   Struktur benar:
   /proxies/{proxyId} => { alive, lastChecked, proxy: "IP:PORT" }
   Jadi list berada di: /proxies.json?auth=...
=============================== */
const RTDB_BASE_URL =
  "https://proxy-cf6c5-default-rtdb.asia-southeast1.firebasedatabase.app";
const RTDB_PROXY_PATH = "proxies";

// ⚠️ Jangan commit ke repo public. Ini ditaruh di sini karena kamu bilang tidak pakai env.
const RTDB_AUTH = "3HMgkYtC2RlIRFKGH5iwThpcALmsGirFGwsAT5tu";

/* ===============================
   HEADERS
=============================== */
const BASE_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
};

// header untuk source lain
const headers = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
};

// header flick search (sesuai curl)
const FLICK_SEARCH_HEADERS = {
  ...BASE_HEADERS,
  accept: "*/*",
  referer: "https://api.sansekai.my.id/",
  connection: "keep-alive",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-ch-ua":
    '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/* ===============================
   SAFE FETCH (DIRECT)
=============================== */
async function safeFetch(url) {
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("FETCH ERROR:", url, err?.message);
    return null;
  }
}

/* ===============================
   RTDB PROXY FETCH + CACHE
=============================== */
let proxyCache = { list: [], ts: 0 };
const CACHE_MS = 30_000;

function rtdbUrl(path) {
  const base = RTDB_BASE_URL.replace(/\/$/, "");
  return `${base}/${path}.json?auth=${encodeURIComponent(RTDB_AUTH)}`;
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

  // ✅ FIX: fetch dari /proxies.json (bukan /proxies/proxies.json)
  const res = await fetch(rtdbUrl(RTDB_PROXY_PATH), { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    debugLog?.push({
      step: "proxy_rtdb_fetch_failed",
      status: res.status,
      body: text.slice(0, 200),
    });
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
   SOCKS5 FETCH for FlickReels Search
   - fallback direct kalau socks gagal
=============================== */
async function fetchFlickSearchViaSocks(url, debug = false, debugLog = []) {
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

  // try socks
  if (meta.proxyUrl) {
    try {
      const agent = new SocksProxyAgent(meta.proxyUrl);
      const { data } = await axios.get(url, {
        headers: FLICK_SEARCH_HEADERS,
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 15000,
        validateStatus: (s) => s >= 200 && s < 300,
      });

      meta.mode = "socks5";
      if (debug) debugLog.push({ step: "flick_search_socks_success" });
      return { json: data ?? null, meta };
    } catch (err) {
      meta.error = err?.message || String(err);
      if (debug)
        debugLog.push({
          step: "flick_search_socks_failed",
          error: meta.error,
        });
      console.error("FLICK SEARCH SOCKS FAILED:", meta.proxyUrl, meta.error);
    }
  } else {
    if (debug) debugLog.push({ step: "flick_no_proxy_available" });
  }

  // fallback direct
  try {
    const res = await fetch(url, {
      headers: FLICK_SEARCH_HEADERS,
      cache: "no-store",
    });
    if (!res.ok) {
      meta.mode = "direct";
      meta.error = `direct_http_${res.status}`;
      if (debug)
        debugLog.push({
          step: "flick_search_direct_failed",
          status: res.status,
        });
      return { json: null, meta };
    }
    const json = await res.json();
    meta.mode = "direct";
    if (debug) debugLog.push({ step: "flick_search_direct_success" });
    return { json, meta };
  } catch (err) {
    meta.mode = "direct";
    meta.error = err?.message || String(err);
    if (debug)
      debugLog.push({
        step: "flick_search_direct_exception",
        error: meta.error,
      });
    return { json: null, meta };
  }
}

/* ===============================
   HANDLER
=============================== */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const debug = searchParams.get("debug") === "1";

  if (!q) {
    return NextResponse.json(
      { error: "query (q) wajib diisi" },
      { status: 400 }
    );
  }

  const debugLog = [];
  const flickDebug = { meta: null };

  try {
    const flickUrl = `${FLICK_SEARCH}?query=${encodeURIComponent(q)}`;

    const [dbJson, nsJson, mlJson, flickRes] = await Promise.all([
      safeFetch(`${DRAMABOX_SEARCH}?query=${encodeURIComponent(q)}`),
      safeFetch(`${NETSHORT_SEARCH}?query=${encodeURIComponent(q)}`),
      safeFetch(
        `${MELOLO_SEARCH}?query=${encodeURIComponent(q)}&limit=10&offset=0`
      ),
      fetchFlickSearchViaSocks(flickUrl, debug, debugLog),
    ]);

    const flickJson = flickRes?.json;
    if (debug) flickDebug.meta = flickRes?.meta;

    /* ===============================
       GLOBAL DEDUP
    =============================== */
    const map = new Map();

    /* ===============================
       DRAMABOX
    =============================== */
    if (Array.isArray(dbJson)) {
      dbJson.forEach((item) => {
        const id = `dramabox_${item.bookId}`;
        if (!item.bookId || map.has(id)) return;

        map.set(id, {
          source: "dramabox",
          id: item.bookId,
          title: item.bookName,
          description: item.introduction,
          cover: item.cover,
          tags: item.tagNames || [],
          vip: item.corner?.cornerType === 4,
        });
      });
    }

    /* ===============================
       NETSHORT
    =============================== */
    const nsList = nsJson?.searchCodeSearchResult || [];
    nsList.forEach((item) => {
      const id = `netshort_${item.shortPlayId}`;
      if (!item.shortPlayId || map.has(id)) return;

      map.set(id, {
        source: "netshort",
        id: item.shortPlayId,
        title: item.shortPlayName?.replace(/<[^>]+>/g, ""),
        description: item.shotIntroduce,
        cover: item.shortPlayCover,
        tags: item.labelNameList || [],
        heat: item.formatHeatScore,
      });
    });

    /* ===============================
       MELOLO
    =============================== */
    const mlGroups = mlJson?.data?.search_data || [];
    mlGroups.forEach((group) => {
      (group.books || []).forEach((book) => {
        const id = `melolo_${book.book_id}`;
        if (!book.book_id || map.has(id)) return;

        map.set(id, {
          source: "melolo",
          id: book.book_id,
          title: book.book_name,
          description: book.abstract,
          cover: book.thumb_url,
          author: book.author,
          tags: book.stat_infos || [],
          episodes: Number(book.serial_count),
          isNew: book.is_new_book === "1",
          isHot: book.is_hot === "1",
          status: book.show_creation_status,
          ageGate: book.age_gate,
        });
      });
    });

    /* ===============================
       FLICKREELS SEARCH
       response: { status_code: 1, msg: "...", data: [...] }
    =============================== */
    if (Array.isArray(flickJson?.data)) {
      flickJson.data.forEach((item) => {
        const id = `flickreels_${item.playlet_id}`;
        if (!item.playlet_id || map.has(id)) return;

        map.set(id, {
          source: "flickreels",
          id: item.playlet_id,
          title: item.title,
          description: item.introduce,
          cover: item.cover,
          episodes: Number(item.upload_num) || 0,
          tags: Array.isArray(item.tag_list)
            ? item.tag_list.map((t) => t.tag_name).filter(Boolean)
            : [],
        });
      });
    }

    const results = Array.from(map.values());

    const respHeaders = new Headers();
    if (debug) {
      respHeaders.set("X-Flick-Proxy-Mode", flickDebug.meta?.mode || "unknown");
      respHeaders.set("X-Flick-Proxy-Used", flickDebug.meta?.proxy || "");
      respHeaders.set("X-Flick-Proxy-Error", flickDebug.meta?.error || "");
    }

    return NextResponse.json(
      debug
        ? {
            query: q,
            total: results.length,
            results,
            sourceFailed: {
              dramabox: dbJson === null,
              netshort: nsJson === null,
              melolo: mlJson === null,
              flickreels: flickJson === null,
            },
            debug: {
              flick: flickDebug,
              steps: debugLog,
              note:
                "Cek debug.flick.meta.mode: 'socks5' berarti request FlickReels search lewat proxy. Kalau 'direct' berarti fallback.",
            },
          }
        : {
            query: q,
            total: results.length,
            results,
            sourceFailed: {
              dramabox: dbJson === null,
              netshort: nsJson === null,
              melolo: mlJson === null,
              flickreels: flickJson === null,
            },
          },
      { headers: respHeaders }
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: err?.message || "Unknown error",
        results: [],
        sourceFailed: {
          dramabox: true,
          netshort: true,
          melolo: true,
          flickreels: true,
        },
        ...(debug ? { debug: { steps: debugLog, flick: flickDebug } } : {}),
      },
      { status: 500 }
    );
  }
}
