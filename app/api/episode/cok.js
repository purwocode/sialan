import { NextResponse } from "next/server";

const MELOLO_STREAM = "https://melolo-api-azure.vercel.app/api/melolo/stream";

const headers = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "max-age=0",
  "sec-ch-ua": `"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": `"Windows"`,
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const vid = searchParams.get("vid");

    if (!vid) {
      return NextResponse.json({ error: "vid wajib diisi" }, { status: 400 });
    }

    const res = await fetch(`${MELOLO_STREAM}/${vid}`, { headers, cache: "no-store" });
    const json = await res.json();

    const mainUrl = json?.data?.main_url;
    if (!mainUrl) {
      return NextResponse.json({ error: "Video tidak tersedia" }, { status: 404 });
    }

    return NextResponse.json({
      vid,
      main_url: mainUrl,
      backup_url: json?.data?.backup_url || null,
      duration: json?.data?.video_duration || 0,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
