// app/api/stream/route.js
import { NextResponse } from "next/server";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "Missing video id" },
      { status: 400 }
    );
  }

  try {
    const apiRes = await fetch(
      `https://melolo-api-azure.vercel.app/api/melolo/stream/${id}`,
      {
        headers: {
          "accept": "application/json",
          "user-agent": "Mozilla/5.0",
        },
        cache: "no-store",
      }
    );

    const json = await apiRes.json();

    const mainUrl = json?.data?.main_url;

    if (!mainUrl) {
      return NextResponse.json(
        { error: "main_url not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      url: mainUrl,
      expire: json.data.expire_time,
      width: json.data.video_width,
      height: json.data.video_height,
    });

  } catch (err) {
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
