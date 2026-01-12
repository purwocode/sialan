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

// ✅ FlickReels detail + all episodes
const FLICK_EP =
  "https://api.sansekai.my.id/api/flickreels/detailAndAllEpisode";

/* ===============================
   RTDB (REST)
   Struktur benar:
   /proxies/{proxyId} => { alive, lastChecked, proxy: "IP:PORT" }
   List: /proxies.json?auth=...
=============================== */
const RTDB_BASE_URL =
  "https://proxy-cf6c5-default-rtdb.asia-southeast1.firebasedatabase.app";
const RTDB_PROXY_PATH = "proxies";

// ✅ Isi dari hosting secrets / variabel server (jangan commit).
// Kalau kamu benar-benar mau hardcode, isi stringnya DI SINI tapi jangan publish repo.
const RTDB_AUTH = "3HMgkYtC2RlIRFKGH5iwThpcALmsGirFGwsAT5tu";

/* ===============================
   HEADERS
=============================== */
const headers = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// Flick headers (minimal sesuai curl)
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
  const base = RTDB_BASE_URL.replace(/\/$/, "");
  const auth = RTDB_AUTH ? `?auth=${encodeURIComponent(RTDB_AUTH)}` : "";
  return `${base}/${path}.json${auth}`;
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
    .filter(
      (p) =>
        p?.alive === true &&
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
   Flick via SOCKS5 (axios) + fallback direct
=============================== */
async function fetchViaSocks(url, debug = false, debugLog = []) {
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
      if (debug)
        debugLog.push({ step: "flick_socks_failed", error: meta.error });
    }
  } else {
    if (debug) debugLog.push({ step: "no_proxy_available" });
  }

  // fallback direct
  try {
    const res = await fetch(url, { headers: FLICK_HEADERS, cache: "no-store" });
    if (!res.ok) {
      meta.mode = "direct";
      meta.error = `direct_http_${res.status}`;
      if (debug)
        debugLog.push({ step: "flick_direct_failed", status: res.status });
      return { json: null, meta };
    }
    const json = await res.json();
    meta.mode = "direct";
    if (debug) debugLog.push({ step: "flick_direct_success" });
    return { json, meta };
  } catch (err) {
    meta.mode = "direct";
    meta.error = err?.message || String(err);
    if (debug)
      debugLog.push({ step: "flick_direct_exception", error: meta.error });
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
  let flickMeta = null;

  try {
    /* ===============================
       0️⃣ FLICKREELS (try first) ✅ via SOCKS5
    =============================== */
    try {
      const flickUrl = `${FLICK_EP}?id=${encodeURIComponent(id)}`;
      const flickRes = await fetchViaSocks(flickUrl, debug, debugLog);
      const flickJson = flickRes?.json;
      flickMeta = flickRes?.meta || null;

      if (flickJson?.drama && Array.isArray(flickJson?.episodes)) {
        const drama = flickJson.drama;

        const episodes = flickJson.episodes.map((ep) => {
          const raw = ep.raw || {};
          const isVip = raw.is_lock === 1 || raw.is_lock === "1";
          return {
            id: String(ep.id ?? raw.chapter_id ?? ""),
            episode: Number(raw.chapter_num ?? (ep.index ?? 0) + 1),
            title: raw.chapter_title || ep.name || `EP ${(ep.index ?? 0) + 1}`,
            thumbnail: raw.chapter_cover || null,
            vip: isVip,
            subtitle: [],
            videos: raw.videoUrl
              ? [{ quality: "auto", url: raw.videoUrl, vip: isVip }]
              : [],
          };
        });

        const payload = {
          source: "flickreels",
          id,
          title: drama.title,
          cover: drama.cover,
          description: drama.description,
          totalEpisode: Number(drama.chapterCount) || episodes.length,
          episodes,
        };

        const respHeaders = new Headers();
        if (debug) {
          respHeaders.set("X-Flick-Proxy-Mode", flickMeta?.mode || "unknown");
          respHeaders.set("X-Flick-Proxy-Used", flickMeta?.proxy || "");
          respHeaders.set("X-Flick-Proxy-Error", flickMeta?.error || "");
        }

        return NextResponse.json(
          debug ? { ...payload, debug: { flick: flickMeta, steps: debugLog } } : payload,
          { headers: respHeaders }
        );
      }
    } catch (e) {
      if (debug) debugLog.push({ step: "flick_exception", error: e?.message });
    }

    /* ===============================
       1️⃣ MELOLO
    =============================== */
    try {
      const meloloRes = await fetch(`${MELOLO_EP}/${id}`, {
        headers,
        cache: "no-store",
      });

      const meloloJson = await meloloRes.json();
      const videoData = meloloJson?.data?.video_data;
      const list = videoData?.video_list;

      if (Array.isArray(list) && list.length > 0) {
        const episodes = await Promise.all(
          list.map(async (ep) => {
            const mainUrl = await resolveMeloloMainUrl(ep.vid);
            return {
              id: ep.vid,
              episode: ep.vid_index,
              title: `EP ${ep.vid_index}`,
              thumbnail: ep.episode_cover || ep.cover,
              vip: ep.disable_play === true,
              subtitle: [],
              videos: mainUrl
                ? [{ quality: "auto", url: mainUrl, vip: ep.disable_play === true }]
                : [],
            };
          })
        );

        return NextResponse.json({
          source: "melolo",
          id,
          title: videoData.series_title,
          cover: videoData.series_cover,
          totalEpisode: videoData.episode_cnt,
          episodes,
        });
      }
    } catch {}

    /* ===============================
       2️⃣ NETSHORT
    =============================== */
    try {
      const nsRes = await fetch(`${NETSHORT_EP}?shortPlayId=${id}`, {
        headers,
        cache: "no-store",
      });

      const nsJson = await nsRes.json();

      if (nsJson?.shortPlayEpisodeInfos) {
        const episodes = nsJson.shortPlayEpisodeInfos.map((ep) => ({
          id: ep.episodeId,
          episode: ep.episodeNo,
          title: `EP ${ep.episodeNo}`,
          thumbnail: ep.episodeCover,
          vip: ep.isVip || ep.isLock,
          subtitle:
            ep.subtitleList?.map((s) => ({
              lang: s.subtitleLanguage,
              url: s.url,
              format: s.format,
            })) || [],
          videos: [{ quality: ep.playClarity, url: ep.playVoucher, vip: ep.isVip }],
        }));

        return NextResponse.json({
          source: "netshort",
          id,
          title: nsJson.shortPlayName,
          cover: nsJson.shortPlayCover,
          totalEpisode: nsJson.totalEpisode,
          episodes,
        });
      }
    } catch {}

    /* ===============================
       3️⃣ DRAMABOX
    =============================== */
    const dbRes = await fetch(`${DRAMABOX_EP}?bookId=${id}`, {
      headers,
      cache: "no-store",
    });

    const dbJson = await dbRes.json();

    if (!Array.isArray(dbJson)) {
      throw new Error("ID tidak valid untuk FlickReels, Melolo, NetShort, maupun DramaBox");
    }

    const episodes = dbJson.map((ep) => {
      const cdn = ep.cdnList?.find((c) => c.isDefault === 1) || ep.cdnList?.[0];

      const videos =
        cdn?.videoPathList?.map((v) => ({
          quality: v.quality,
          url: v.videoPath,
          vip: v.isVipEquity === 1,
        })) || [];

      return {
        id: ep.chapterId,
        episode: ep.chapterIndex + 1,
        title: ep.chapterName,
        thumbnail: ep.chapterImg,
        vip: ep.isCharge === 1,
        subtitle: ep.spriteSnapshotUrl
          ? [{ lang: "auto", url: ep.spriteSnapshotUrl, format: "webvtt" }]
          : [],
        videos,
      };
    });

    return NextResponse.json({
      source: "dramabox",
      id,
      totalEpisode: episodes.length,
      episodes,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
