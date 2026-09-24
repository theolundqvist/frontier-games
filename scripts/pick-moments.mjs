// Default: heuristic cover_at/preview_start for entries without one. --sheets <dir>: contact sheets for picking both by eye.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { duration, ff, rawVideo } from "./source.mjs";

const W = 320, H = 180, FPS = 2, CELL = 384;
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const args = process.argv.slice(2);
const sheetsAt = args[0] === "--sheets" ? args[1] : null;
const only = sheetsAt ? args.slice(2) : args;
const targets = games.filter((g) => existsSync(`media/${g.id}/creator.mp4`) && (only.length ? only.includes(g.id) : sheetsAt || g.cover_at == null));

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

// Best distinct frame per equal slice of the video, topped up from the global ranking.
function shortlist(frames, n) {
  const picks = [], distinct = (f) => picks.every((p) => Math.abs(p.t - f.t) >= 1.5 && dist(p.sig, f.sig) > 6);
  const t0 = frames[0].t, span = frames.at(-1).t - t0 + 1e-9;
  for (let k = 0; k < n; k++) {
    const best = frames.filter((f) => f.t - t0 >= (k * span) / n && f.t - t0 < ((k + 1) * span) / n).sort((a, b) => b.score - a.score).find(distinct);
    if (best) picks.push(best);
  }
  for (const f of [...frames].sort((a, b) => b.score - a.score)) if (picks.length < n && distinct(f)) picks.push(f);
  return picks.sort((a, b) => a.t - b.t);
}

// Non-overlapping 6 s windows ranked by frame quality and motion, penalising dud frames and hard cuts.
function windows(frames, d) {
  if (d <= 6) return [0];
  const scored = [];
  for (let start = 0; start <= d - 6; start += 0.5) {
    const w = frames.filter((f) => f.t >= start && f.t < start + 6);
    if (!w.length) continue;
    const avg = w.reduce((a, f) => a + f.score, 0) / w.length;
    const motion = w.slice(1).reduce((a, f) => a + f.cut, 0) / Math.max(1, w.length - 1);
    scored.push({ start, v: avg - 1.5 * w.filter((f) => f.bad).length - 0.6 * w.filter((f) => f.cut > 40).length + Math.min(motion, 8) / 4 - (motion < 1 ? 1 : 0) });
  }
  const picks = [];
  for (const s of scored.sort((a, b) => b.v - a.v)) if (picks.every((p) => Math.abs(p - s.start) >= 6)) picks.push(s.start);
  return picks;
}

function sheet(source, cells, cols, out) {
  const dir = mkdtempSync(`${tmpdir()}/pick-`);
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", source]).toString().trim().split(",").map(Number);
  const ch = Math.round((CELL * h) / w / 2) * 2;
  cells.forEach(({ t, label }, i) => ff("-ss", String(t), "-i", source, "-frames:v", "1", "-vf",
    `scale=${CELL}:${ch},drawbox=x=0:y=0:w=${14 * label.length + 12}:h=34:color=black@0.75:t=fill,drawtext=fontfile=${FONT}:text='${label}':fontsize=24:fontcolor=yellow:x=6:y=5`,
    `${dir}/${String(i).padStart(2, "0")}.png`));
  ff("-framerate", "1", "-i", `${dir}/%02d.png`, "-vf", `tile=${cols}x${Math.ceil(cells.length / cols)}:padding=4:color=white`, "-frames:v", "1", "-q:v", "3", out);
  rmSync(dir, { recursive: true });
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

if (sheetsAt) mkdirSync(sheetsAt, { recursive: true });
for (const g of targets) {
  const dir = `media/${g.id}`;
  const cached = existsSync(`${dir}/.raw.mp4`);
  try {
    const source = (await rawVideo(g, dir)) ?? `${dir}/creator.mp4`;
    const d = duration(source);
    const frames = analyse(source, d);
    const top = windows(frames, d);
    if (!sheetsAt) {
      const at = [...frames].sort((a, b) => b.score - a.score)[0].t;
      record(g.id, { cover_at: at, preview_start: top[0] });
      console.log(`${g.id}: cover ${at}s, clip ${top[0]}s`);
      continue;
    }
    const picks = shortlist(frames, 20);
    sheet(source, picks.map((p, i) => ({ t: p.t, label: `${i + 1}  ${p.t}s` })), 5, `${sheetsAt}/${g.id}-frames.jpg`);
    const clip = top.slice(0, 3).flatMap((s, k) => [0, 1, 2, 3, 4, 5].map((o) => ({ t: Math.min(s + o, d - 0.1), label: `${"ABC"[k]}  ${s + o}s` })));
    sheet(source, clip, 6, `${sheetsAt}/${g.id}-clips.jpg`);
    console.log(`${g.id} ${d.toFixed(1)}s ${source.endsWith(".raw.mp4") ? "raw" : "creator"} windows=${top.slice(0, 3).join(",")} now cover@${g.cover_at} clip@${g.preview_start}`);
  } catch (e) {
    console.log(`FAIL ${g.id}: ${e.message}`);
  }
  if (sheetsAt && !cached) rmSync(`${dir}/.raw.mp4`, { force: true });
}
