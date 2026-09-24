// `rate.mjs [--force] [ids]` writes each unrated entry's frame sheet and evidence text; `rate.mjs --finalize` validates ratings.yaml and computes overall.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const OUT = process.env.RATE_DIR ?? join(tmpdir(), "frontier-games-rate");
const RATINGS = "data/ratings.yaml";
const MODEL = "claude-opus-5-5";
const WEIGHTS = {
  game: { visuals: 0.3, gameplay: 0.35, polish: 0.15, ambition: 0.2, story: 0.2 },
  film: { visuals: 1, story: 1, craft: 1, ambition: 1 },
};
const OPTIONAL = new Set(["story"]);

const games = parse(readFileSync("data/games.yaml", "utf8"));
const ratings = existsSync(RATINGS) ? parse(readFileSync(RATINGS, "utf8")) ?? {} : {};
const args = process.argv.slice(2);
const kindOf = (g) => (g.kind === "film" ? "film" : "game");

function overall(kind, r) {
  const used = Object.entries(WEIGHTS[kind]).filter(([k]) => !(kind === "game" && k === "story" && r.story === null));
  const total = used.reduce((s, [, w]) => s + w, 0);
  return Math.round((used.reduce((s, [k, w]) => s + w * r[k], 0) / total) * 10) / 10;
}

function validate(g, r) {
  const kind = kindOf(g);
  const fail = (msg) => { throw new Error(`${g.id}: ${msg}`); };
  for (const k of Object.keys(WEIGHTS[kind])) {
    const v = r[k];
    if (v === null && kind === "game" && OPTIONAL.has(k)) continue;
    if (!Number.isInteger(v) || v < 1 || v > 10) fail(`${k} must be an integer 1-10, got ${JSON.stringify(v)}`);
  }
  const foreign = kind === "game" ? ["craft"] : ["gameplay", "polish"];
  if (foreign.some((k) => r[k] != null)) fail(`a ${kind} has no ${foreign.join("/")}`);
  if (typeof r.summary !== "string" || !r.summary.trim()) fail("summary missing");
  if (r.summary.trim().split(/\s+/).length >= 20) fail(`summary must be under 20 words: ${r.summary}`);
  if (!["low", "medium", "high"].includes(r.confidence)) fail(`confidence must be low/medium/high, got ${r.confidence}`);
  if (typeof r.rated_at !== "string" || Number.isNaN(Date.parse(r.rated_at))) fail("rated_at must be an ISO date");
}

function finalize() {
  const known = new Map(games.map((g) => [g.id, g]));
  const stray = Object.keys(ratings).filter((id) => !known.has(id));
  if (stray.length) throw new Error(`ratings for unknown ids: ${stray.join(", ")}`);
  const out = {};
  for (const g of games) {
    const r = ratings[g.id];
    if (!r) continue;
    validate(g, r);
    const kind = kindOf(g);
    out[g.id] = {
      visuals: r.visuals,
      ...(kind === "game" ? { gameplay: r.gameplay, polish: r.polish } : {}),
      ...(kind === "film" ? { craft: r.craft } : {}),
      ambition: r.ambition,
      story: r.story ?? null,
      overall: overall(kind, r),
      summary: r.summary.trim(),
      confidence: r.confidence,
      model: MODEL,
      rated_at: r.rated_at,
    };
  }
  writeFileSync(RATINGS, stringify(out, { lineWidth: 0 }));
  const missing = games.filter((g) => !out[g.id]).map((g) => g.id);
  console.log(`${Object.keys(out).length} rated, ${missing.length} missing${missing.length ? `: ${missing.join(" ")}` : ""}`);
}

const ff = (...a) => execFileSync("nice", ["-n", "19", "ffmpeg", "-y", "-loglevel", "error", "-threads", "2", ...a]);
const duration = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

function sheet(g, out) {
  const video = `media/${g.id}/creator.mp4`;
  if (!existsSync(video)) {
    ff("-i", `media/${g.id}/cover.png`, "-vf", "scale=1600:-2:flags=lanczos", "-q:v", "3", out);
    return "one still screenshot";
  }
  const d = duration(video);
  const tmp = mkdtempSync(join(tmpdir(), "rate-"));
  const times = Array.from({ length: 6 }, (_, i) => d * (0.03 + (0.94 * i) / 5));
  times.forEach((t, i) => ff("-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=534:300:force_original_aspect_ratio=decrease,pad=534:300:(ow-iw)/2:(oh-ih)/2", `${tmp}/${i}.png`));
  ff("-i", `${tmp}/%d.png`, "-vf", "tile=3x2,scale=1600:-2", "-frames:v", "1", "-q:v", "3", out);
  rmSync(tmp, { recursive: true });
  return `6 frames at ${times.map((t) => `${t.toFixed(1)}s`).join(", ")} of the creator's first ${d.toFixed(0)} s (left to right, top to bottom)`;
}

async function post(g) {
  const id = g.post_url?.split("/status/")[1]?.split(/[/?]/)[0];
  if (!id) return "No X post.";
  let res;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch(`https://api.fxtwitter.com/2/conversation/${id}`);
    if (res.ok) break;
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  if (!res.ok) throw new Error(`${g.id}: fxtwitter ${res.status}`);
  const { status: s, replies = [] } = await res.json();
  const author = s.author?.screen_name;
  const top = replies.filter((r) => r.author?.screen_name !== author).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 15);
  return [
    `X post by @${author} (${s.created_at}): likes ${s.likes}, reposts ${s.reposts}, replies ${s.replies}, views ${s.views ?? "n/a"}`,
    s.text,
    s.quote ? `Quoting @${s.quote.author?.screen_name}: ${s.quote.text}` : null,
    top.length ? `Top replies (${top.length}):\n${top.map((r) => `- [${r.likes} likes] ${r.text.replace(/^(@\w+\s+)+/, "").replace(/\s+/g, " ")}`).join("\n")}` : "No replies returned.",
  ].filter(Boolean).join("\n\n");
}

async function evidence() {
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  mkdirSync(OUT, { recursive: true });
  const todo = games.filter((g) => (only.length ? only.includes(g.id) : force || !ratings[g.id]));
  for (const g of todo) {
    const frames = sheet(g, `${OUT}/${g.id}.jpg`);
    const fields = ["title", "kind", "tier", "genre", "engine", "runtime", "build", "description", "controls"];
    const facts = stringify(Object.fromEntries(fields.filter((k) => g[k] != null).map((k) => [k, g[k]])), { lineWidth: 0 });
    writeFileSync(`${OUT}/${g.id}.txt`, `${g.id} (${kindOf(g)})\nImage: ${frames}\n\n${facts}\n${await post(g)}\n`);
    console.log(`${OUT}/${g.id}.jpg`);
  }
}

await (args.includes("--finalize") ? finalize() : evidence());
