import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const ff = (...args) => execFileSync("nice", ["-n", "19", "ffmpeg", "-y", "-loglevel", "error", "-threads", "2", ...args.slice(0, -1), "-threads", "2", ...args.slice(-1)]);
export const duration = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

// The original post video at full resolution; creator.mp4 is only its first 20 s at 960 wide.
export async function rawVideo(g, dir) {
  const raw = `${dir}/.raw.mp4`;
  if (existsSync(raw)) return raw;
  if (!g.post_url?.includes("/status/")) return null;
  const id = g.post_url.split("/status/")[1].split(/[/?]/)[0];
  const tweet = (await (await fetch(`https://api.fxtwitter.com/i/status/${id}`)).json()).tweet;
  const video = [...(tweet?.media?.videos ?? []), ...(tweet?.quote?.media?.videos ?? [])][0];
  if (!video) return null;
  execFileSync("curl", ["-sfL", "-o", raw, video.url]);
  return raw;
}

// Union of cropdetect boxes around [start, start + length], so letterbox bars are trimmed without cutting into dark scenes.
export function borderCrop(source, start, length) {
  const log = spawnSync("nice", ["-n", "19", "ffmpeg", "-threads", "2", "-ss", String(start), "-t", String(length), "-i", source,
    "-vf", "fps=4,cropdetect=limit=24:round=2:reset=1", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const boxes = [...log.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].map((m) => m.slice(1).map(Number));
  if (!boxes.length) return "null";
  const [x1, x2, y1, y2] = [Math.min(...boxes.map((b) => b[0])), Math.max(...boxes.map((b) => b[1])), Math.min(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  const w = (x2 - x1 + 1) & ~1, h = (y2 - y1 + 1) & ~1;
  return w > 0 && h > 0 ? `crop=${w}:${h}:${x1}:${y1}` : "null";
}
