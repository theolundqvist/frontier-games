import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { parse } from "yaml";
import { borderCrop, duration, ff, rawVideo } from "./source.mjs";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const only = process.argv.slice(2);
const kb = (f) => Math.round(statSync(f).size / 1024);

function creatorVideo(raw, out) {
  ff("-i", raw, "-t", "20", "-vf", "scale='min(960,iw)':-2,fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out);
}

function loop(source, start, crop, out) {
  for (const rate of [["-crf", "27"], ["-crf", "30"], ["-crf", "33"], ["-b:v", "850k", "-maxrate", "900k", "-bufsize", "1800k"]]) {
    ff("-ss", start, "-t", "6", "-i", source, "-vf", `${crop},scale=960:-2:flags=lanczos,fps=30,format=yuv420p`, "-an",
      "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", ...rate, "-movflags", "+faststart", out);
    if (statSync(out).size < 700 * 1024) return;
  }
}

for (const g of games.filter((g) => !only.length || only.includes(g.id))) {
  const dir = `media/${g.id}`;
  mkdirSync(dir, { recursive: true });
  let raw = null;
  try { raw = await rawVideo(g, dir); } catch (e) { console.log(`video ${g.id}: ${e.message}`); }
  if (raw && !existsSync(`${dir}/creator.mp4`)) creatorVideo(raw, `${dir}/creator.mp4`);
  if (!existsSync(`${dir}/creator.mp4`)) {
    rmSync(raw ?? `${dir}/.raw.mp4`, { force: true });
    if (!existsSync(`${dir}/cover.png`)) { console.log(`NO MEDIA ${g.id}`); continue; }
    const crop = borderCrop(`${dir}/cover.png`, 0, 1);
    ff("-i", `${dir}/cover.png`, "-vf", `${crop},scale=1600:-2:flags=lanczos`, "-q:v", "3", `${dir}/cover.jpg`);
    ff("-i", `${dir}/cover.png`, "-vf", `${crop},scale=400:-2`, "-quality", "70", `${dir}/preview.webp`);
    console.log(`still ${g.id} ${crop}`);
    continue;
  }
  const source = raw ?? `${dir}/creator.mp4`;
  const d = duration(source);
  const start = Math.max(0, Math.min(g.preview_start ?? d * 0.3, d - 6));
  const at = Math.min(g.cover_at ?? start + 2, d - 0.1);
  const coverCrop = borderCrop(source, Math.max(0, at - 1.5), 3);
  const clipCrop = borderCrop(source, start, 6);
  ff("-ss", String(at), "-i", source, "-frames:v", "1", "-vf", `${coverCrop},scale='min(1920,iw)':-2:flags=lanczos`, `${dir}/cover.png`);
  ff("-i", `${dir}/cover.png`, "-vf", "scale='min(1600,iw)':-2:flags=lanczos", "-q:v", "3", `${dir}/cover.jpg`);
  ff("-ss", String(start), "-t", "6", "-i", source, "-vf", `${clipCrop},fps=10,scale=400:-2:flags=lanczos`, "-loop", "0", "-c:v", "libwebp", "-quality", "50", "-an", `${dir}/preview.webp`);
  loop(source, String(start), clipCrop, `${dir}/loop.mp4`);
  rmSync(`${dir}/.raw.mp4`, { force: true });
  console.log(`ok ${g.id} ${raw ? "raw" : "creator"} cover@${at} clip@${start} preview=${kb(`${dir}/preview.webp`)}KB loop=${kb(`${dir}/loop.mp4`)}KB`);
}
