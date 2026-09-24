import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const only = process.argv.slice(2);
const videos = parse(readFileSync("data/videos.yaml", "utf8")) ?? {};

// X serves the original upload at every size; 1080p keeps the dialog sharp without 4K bitrates.
for (const g of games.filter((g) => g.post_url?.includes("/status/") && (!only.length || only.includes(g.id)))) {
  const id = g.post_url.split("/status/")[1].split(/[/?]/)[0];
  const tweet = (await (await fetch(`https://api.fxtwitter.com/i/status/${id}`)).json()).tweet;
  const video = [...(tweet?.media?.videos ?? []), ...(tweet?.quote?.media?.videos ?? [])][0];
  const mp4 = (video?.variants ?? []).filter((v) => v.content_type === "video/mp4" && !/\/(\d+)x(\d+)\//.exec(v.url)?.slice(1).some((n) => n > 1920))
    .sort((a, b) => b.bitrate - a.bitrate)[0];
  if (mp4) videos[g.id] = mp4.url.split("?")[0]; else delete videos[g.id];
  console.log(g.id, videos[g.id] ?? "-", video?.duration ?? "");
}
writeFileSync("data/videos.yaml", stringify(Object.fromEntries(Object.entries(videos).sort())));
