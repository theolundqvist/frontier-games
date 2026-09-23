import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const only = process.argv.slice(2);
const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const duration = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

async function creatorVideo(g, dir) {
  const out = `${dir}/creator.mp4`;
  if (existsSync(out) || !g.post_url?.includes("/status/")) return;
  const id = g.post_url.split("/status/")[1].split(/[/?]/)[0];
  const tweet = (await (await fetch(`https://api.fxtwitter.com/i/status/${id}`)).json()).tweet;
  const video = [...(tweet?.media?.videos ?? []), ...(tweet?.quote?.media?.videos ?? [])][0];
  if (!video) return;
  const raw = `${dir}/.raw.mp4`;
  execFileSync("curl", ["-sL", "-o", raw, video.url]);
  ff("-i", raw, "-t", "20", "-vf", "scale='min(960,iw)':-2,fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out);
  execFileSync("rm", ["-f", raw]);
}

for (const g of games.filter((g) => !only.length || only.includes(g.id))) {
  const dir = `media/${g.id}`;
  mkdirSync(dir, { recursive: true });
  try { await creatorVideo(g, dir); } catch (e) { console.log(`video ${g.id}: ${e.message}`); }
  const source = `${dir}/creator.mp4`;
  if (!existsSync(source)) {
    if (existsSync(`${dir}/cover.png`)) ff("-i", `${dir}/cover.png`, "-vf", "scale=960:-2", "-q:v", "4", `${dir}/cover.jpg`), ff("-i", `${dir}/cover.png`, "-vf", "scale=400:-2", "-quality", "70", `${dir}/preview.webp`);
    console.log(`${existsSync(`${dir}/cover.png`) ? "still" : "NO MEDIA"} ${g.id}`);
    continue;
  }
  const d = duration(source);
  const start = String(g.preview_start ?? Math.max(0, Math.min(d * 0.3, d - 6)));
  if (!existsSync(`${dir}/cover.png`) || g.cover_from_video) ff("-ss", String(Number(start) + 2), "-i", source, "-frames:v", "1", "-vf", "scale=1280:-2", `${dir}/cover.png`);
  ff("-ss", start, "-t", "6", "-i", source, "-vf", "fps=10,scale=400:-2:flags=lanczos", "-loop", "0", "-c:v", "libwebp", "-quality", "50", "-an", `${dir}/preview.webp`);
  ff("-i", `${dir}/cover.png`, "-vf", "scale=960:-2", "-q:v", "4", `${dir}/cover.jpg`);
  console.log(`ok ${g.id} ${source.split("/").pop()} preview=${Math.round(statSync(`${dir}/preview.webp`).size / 1024)}KB`);
}
