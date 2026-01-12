import { NextResponse } from "next/server";
import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";

export const runtime = "nodejs";

// OPTIONAL: kalau mau fetch video via socks5 (isi "ip:port" atau kosongkan)
const FORCE_SOCKS_PROXY = "";

// whitelist host video biar endpoint kamu tidak jadi open proxy
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

  const range = req.headers.get("range") || undefined;

  // penting: bikin upstream request terlihat “allowed”
  const upstreamHeaders = {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    // hotlink biasanya cek ini:
    Referer: "https://api.sansekai.my.id/",
    Origin: "https://api.sansekai.my.id",
    ...(range ? { Range: range } : {}),
  };

  try {
    const axiosConfig = {
      method: "GET",
      url,
      responseType: "stream",
      headers: upstreamHeaders,
      timeout: 30000,
      validateStatus: () => true,
    };

    if (FORCE_SOCKS_PROXY) {
      const agent = new SocksProxyAgent(`socks5://${FORCE_SOCKS_PROXY}`);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
    }

    const upstream = await axios(axiosConfig);

    // forward error biar gampang debug
    if (upstream.status >= 400) {
      const respHeaders = new Headers();
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("Cache-Control", "no-store");
      respHeaders.set("Content-Type", upstream.headers["content-type"] || "text/plain");

      return new NextResponse(
        `upstream_${upstream.status}`,
        { status: upstream.status, headers: respHeaders }
      );
    }

    const respHeaders = new Headers();
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Expose-Headers", "*");
    respHeaders.set("Cache-Control", "no-store");

    // headers penting buat streaming
    const ct = upstream.headers["content-type"] || "video/mp4";
    respHeaders.set("Content-Type", ct);

    const acceptRanges = upstream.headers["accept-ranges"] || "bytes";
    respHeaders.set("Accept-Ranges", acceptRanges);

    const contentLength = upstream.headers["content-length"];
    if (contentLength) respHeaders.set("Content-Length", String(contentLength));

    const contentRange = upstream.headers["content-range"];
    if (contentRange) respHeaders.set("Content-Range", String(contentRange));

    // kalau request range → biasanya 206
    const status = upstream.status === 206 ? 206 : 200;

    return new NextResponse(upstream.data, { status, headers: respHeaders });
  } catch (err) {
    return new NextResponse(`stream_error_${err?.message || "unknown"}`, {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
