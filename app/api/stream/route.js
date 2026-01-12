import { NextResponse } from "next/server";
import axios from "axios";

export const runtime = "nodejs";

// Biar endpoint kamu nggak jadi open-proxy, whitelist host video
const ALLOWED_HOSTS = new Set([
  "zshipricf.farsunpteltd.com",
  "zshipubcdn.farsunpteltd.com",
]);

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "url wajib diisi" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "url tidak valid" }, { status: 400 });
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return NextResponse.json({ error: "host tidak diizinkan" }, { status: 403 });
  }

  // Range penting untuk <video> (seek/streaming)
  const range = req.headers.get("range") || undefined;

  // Hotlink protection: spoof referer/origin yang aman
  const upstreamHeaders = {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",

    Referer: "https://api.sansekai.my.id/",
    Origin: "https://api.sansekai.my.id",

    ...(range ? { Range: range } : {}),
  };

  try {
    const upstream = await axios.get(url, {
      responseType: "stream",
      headers: upstreamHeaders,
      timeout: 30000,
      validateStatus: () => true, // kita handle status sendiri
    });

    // Kalau upstream error (mis. 403), teruskan status biar gampang debug di Network
    if (upstream.status >= 400) {
      const h = new Headers();
      h.set("Access-Control-Allow-Origin", "*");
      h.set("Access-Control-Expose-Headers", "*");
      h.set("Cache-Control", "no-store");
      h.set("Content-Type", upstream.headers["content-type"] || "text/plain");

      return new NextResponse(`upstream_${upstream.status}`, {
        status: upstream.status,
        headers: h,
      });
    }

    // Forward header penting streaming
    const h = new Headers();
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Access-Control-Expose-Headers", "*");
    h.set("Cache-Control", "no-store");

    h.set("Content-Type", upstream.headers["content-type"] || "video/mp4");
    h.set("Accept-Ranges", upstream.headers["accept-ranges"] || "bytes");

    const contentLength = upstream.headers["content-length"];
    if (contentLength) h.set("Content-Length", String(contentLength));

    const contentRange = upstream.headers["content-range"];
    if (contentRange) h.set("Content-Range", String(contentRange));

    // Kalau request pakai range → 206, kalau tidak → 200
    const status = upstream.status === 206 ? 206 : 200;

    return new NextResponse(upstream.data, { status, headers: h });
  } catch (err) {
    return new NextResponse(`stream_error_${err?.message || "unknown"}`, {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
        "Cache-Control": "no-store",
      },
    });
  }
}

// Preflight CORS (biar aman cross-origin dari frontend lain)
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
    },
  });
}
