// Heuristics shortlist twelve distinct frames, Gemini picks the cover from a numbered sheet; writes cover_at and preview_start.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { duration, ff, rawVideo } from "./source.mjs";

const MODEL = "gemini-3.1-pro-preview";
const W = 320, H = 180, FPS = 2, CELL = 480;
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const only = process.argv.slice(2);
const targets = games.filter((g) => existsSync(`media/${g.id}/creator.mp4`) && (only.length ? only.includes(g.id) : g.cover_at == null));

function measure(px) {
  const n = W * H, Y = new Float32Array(n), bins = new Uint32Array(4096);
  let sy = 0, syy = 0, srg = 0, srg2 = 0, syb = 0, syb2 = 0;
  for (let i = 0; i < n; i++) {
    const r = px[3 * i], g = px[3 * i + 1], b = px[3 * i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b, rg = r - g, yb = 0.5 * (r + g) - b;
    Y[i] = y; sy += y; syy += y * y; srg += rg; srg2 += rg * rg; syb += yb; syb2 += yb * yb;
    bins[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
  }
  const mean = sy / n, contrast = Math.sqrt(syy / n - mean * mean);
  const mrg = srg / n, myb = syb / n;
  const colour = Math.sqrt(srg2 / n - mrg * mrg + syb2 / n - myb * myb) + 0.3 * Math.hypot(mrg, myb);
  let sl = 0, sll = 0, m = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, l = 4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - W] - Y[i + W];
    sl += l; sll += l * l; m++;
  }
  const sharp = Math.log1p(sll / m - (sl / m) ** 2);
  const flat = Math.max(...bins) / n;
  const sig = new Float32Array(16 * 9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sig[((y / 20) | 0) * 16 + ((x / 20) | 0)] += Y[y * W + x] / 400;
  return { mean, contrast, colour, sharp, flat, sig };
}

const dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const z = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length, s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1; return xs.map((x) => (x - m) / s); };

function analyse(source, d) {
  const buf = execFileSync("nice", ["-n", "19", "ffmpeg", "-loglevel", "error", "-threads", "2", "-i", source,
    "-vf", `fps=${FPS},scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 2 ** 31 });
  const frames = [];
  for (let o = 0, k = 0; o + W * H * 3 <= buf.length; o += W * H * 3, k++) frames.push({ t: k / FPS, ...measure(buf.subarray(o, o + W * H * 3)) });
  frames.forEach((f, i) => { f.cut = i ? dist(f.sig, frames[i - 1].sig) : 0; });
  const [zs, zc, zk] = [z(frames.map((f) => f.sharp)), z(frames.map((f) => f.colour)), z(frames.map((f) => f.contrast))];
  frames.forEach((f, i) => {
    f.bad = f.mean < 35 || f.mean > 225 || f.flat > 0.45 || f.colour < 8;
    f.score = 0.8 * zs[i] + zc[i] + 0.4 * zk[i] - (f.bad ? 3 : 0) - 2 * Math.max(0, f.flat - 0.25);
  });
  const skip = Math.min(3, d * 0.03);
  return frames.filter((f) => f.t >= skip && f.t <= d - skip);
}

function shortlist(frames) {
  const picks = [], ranked = [...frames].sort((a, b) => b.score - a.score);
  for (const minDist of [10, 0]) for (const f of ranked) {
    if (picks.length < 12 && picks.every((p) => Math.abs(p.t - f.t) >= 1.5 && dist(p.sig, f.sig) > minDist)) picks.push(f);
  }
  return picks.sort((a, b) => a.t - b.t);
}

function sheet(source, picks, out) {
  const dir = mkdtempSync(`${tmpdir()}/pick-`);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", source]).toString().trim().split(",").map(Number);
  const ch = Math.round((CELL * h) / w / 2) * 2;
  picks.forEach((p, i) => ff("-ss", String(p.t), "-i", source, "-frames:v", "1", "-vf",
    `scale=${CELL}:${ch},drawbox=x=0:y=0:w=64:h=52:color=black@0.75:t=fill,drawtext=fontfile=${FONT}:text=${i + 1}:fontsize=40:fontcolor=yellow:x=10:y=6`,
    `${dir}/${String(i).padStart(2, "0")}.png`));
  ff("-framerate", "1", "-i", `${dir}/%02d.png`, "-vf", `tile=4x${Math.ceil(picks.length / 4)}:padding=6:color=white`, "-frames:v", "1", "-q:v", "3", out);
  rmSync(dir, { recursive: true });
}

async function choose(g, img, n) {
  const project = execFileSync("gcloud", ["config", "get-value", "project"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const token = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
  const what = g.kind === "film" ? "an AI-made film" : "a game built with AI";
  const prompt = `These ${n} numbered frames come from a video showing "${g.title}", ${what} (${g.genre ?? ""}): ${g.description}
Pick the single frame that would make the most visually striking gallery cover: it must show the actual ${g.kind === "film" ? "film footage" : "gameplay or game world"}, be sharp, well lit, colourful and well composed.
Reject title cards, logos, menus, loading screens, code editors, chat or prompt windows, tweets, desktop or browser chrome, side-by-side comparison layouts, and webcam or face-cam overlays whenever a cleaner frame exists.
Answer as JSON: {"frame": <number>, "reason": "<one short sentence>"}.`;
  const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: readFileSync(img).toString("base64") } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  const body = await res.json();
  const text = body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text).join("");
  if (!text) throw new Error(`Gemini ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const answer = JSON.parse(text);
  if (!(answer.frame >= 1 && answer.frame <= n)) throw new Error(`Gemini picked ${text}`);
  return answer;
}

function window(frames, t, d) {
  if (d <= 6) return 0;
  let best = { v: -Infinity, s: 0 };
  for (let s = t - 5.5; s <= t + 1; s += 0.5) {
    const start = Math.max(0, Math.min(s, d - 6));
    const w = frames.filter((f) => f.t >= start && f.t < start + 6);
    if (!w.length) continue;
    const avg = w.reduce((a, f) => a + f.score, 0) / w.length;
    const motion = w.slice(1).reduce((a, f) => a + f.cut, 0) / Math.max(1, w.length - 1);
    const v = avg - 1.5 * w.filter((f) => f.bad).length - 0.6 * w.filter((f) => f.cut > 40).length - (motion < 1 ? 1 : 0) + (start <= t && t < start + 6 ? 0.5 : 0);
    if (v > best.v) best = { v, s: start };
  }
  return Math.round(best.s * 10) / 10;
}

function record(id, fields) {
  const lines = readFileSync("data/games.yaml", "utf8").split("\n");
  const from = lines.indexOf(`- id: ${id}`);
  let to = from + 1;
  while (to < lines.length && lines[to].trim() !== "" && !lines[to].startsWith("- id:")) to++;
  const block = lines.slice(from, to).filter((l) => !Object.keys(fields).some((k) => l.startsWith(`  ${k}:`)));
  block.push(...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`));
  lines.splice(from, to - from, ...block);
  writeFileSync("data/games.yaml", lines.join("\n"));
}

for (const g of targets) {
  const dir = `media/${g.id}`;
  try {
    const source = (await rawVideo(g, dir)) ?? `${dir}/creator.mp4`;
    const d = duration(source);
    const frames = analyse(source, d);
    const picks = shortlist(frames);
    const img = `${tmpdir()}/${g.id}-candidates.jpg`;
    sheet(source, picks, img);
    const answer = await choose(g, img, picks.length);
    if (!process.env.KEEP_SHEET) rmSync(img);
    const at = picks[answer.frame - 1].t;
    const start = window(frames, at, d);
    record(g.id, { cover_at: at, preview_start: start });
    console.log(`${g.id}: frame ${answer.frame} of [${picks.map((p) => p.t).join(" ")}] at ${at}s, clip ${start}s (${d.toFixed(1)}s) - ${answer.reason}`);
  } catch (e) {
    console.log(`FAIL ${g.id}: ${e.message}`);
  }
}
