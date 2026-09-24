import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { parse } from "yaml";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const ratings = parse(readFileSync("data/ratings.yaml", "utf8"));
const videos = parse(readFileSync("data/videos.yaml", "utf8"));
const MODELS = { "claude-opus-5.5": "Claude Opus 5.5", "gpt-6-astra": "GPT-6 Astra" };
const SECTIONS = [
  { key: "play", title: "Play in your browser", blurb: "One click, no install, no sign-in.", test: (g) => g.kind !== "film" && g.tier === "play" },
  { key: "download", title: "Download or build", blurb: "Playable, but needs a download, a build step, or a native engine.", test: (g) => g.kind !== "film" && g.tier === "download" },
  { key: "watch", title: "Watch only", blurb: "No public build yet. The creator's footage is the evidence.", test: (g) => g.kind !== "film" && g.tier === "watch" },
  { key: "films", title: "Films and animations", blurb: "Music videos, short films and animations where the model wrote the code or drove the tool behind every frame.", test: (g) => g.kind === "film" },
];

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n ?? ""));
const byLikes = (a, b) => (b.post_likes ?? 0) - (a.post_likes ?? 0);
const link = (label, url) => (url ? `[${label}](${url})` : null);

function cell(g) {
  const target = g.play_url ?? g.watch_url ?? g.download_url ?? g.post_url;
  const links = [
    link("**▶ Play**", g.play_url), link("**▶ Watch live**", g.watch_url), link("Download", g.download_url), link("Source", g.repo_url),
    link(`Post${g.post_likes ? ` · ${compact(g.post_likes)} ♥` : ""}`, g.post_url),
  ].filter(Boolean).join(" · ");
  const meta = [g.genre, g.runtime, g.engine, g.build].filter(Boolean).join(" · ");
  const creator = g.creator_handle ? `[@${g.creator_handle}](https://x.com/${g.creator_handle})` : g.creator_name;
  return [
    `<a href="${target}"><img src="media/${g.id}/preview.webp" width="400" alt="${g.title}"></a><br>`,
    `**${g.title}** by ${creator}<br>`,
    `<sub>${meta}</sub><br>`,
    `${g.description}<br>`,
    g.controls ? `<sub>🎮 ${g.controls}</sub><br>` : "",
    g.run ? `<sub><code>${g.run}</code></sub><br>` : "",
    links,
  ].join("");
}

function grid(list) {
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(`<tr>\n<td width="50%" valign="top">\n\n${cell(list[i])}\n\n</td>\n<td width="50%" valign="top">\n\n${list[i + 1] ? cell(list[i + 1]) : ""}\n\n</td>\n</tr>`);
  }
  return `<table>\n${rows.join("\n")}\n</table>`;
}

const counts = Object.fromEntries(SECTIONS.map((t) => [t.key, games.filter(t.test).length]));
const sections = SECTIONS.filter((t) => counts[t.key]).map((t) => {
  const inTier = games.filter(t.test);
  const perModel = Object.entries(MODELS).map(([m, name]) => {
    const list = inTier.filter((g) => g.model === m).sort(byLikes);
    return list.length ? `### ${name} (${list.length})\n\n${grid(list)}` : "";
  }).filter(Boolean).join("\n\n");
  return `## ${t.title} (${counts[t.key]})\n\n${t.blurb}\n\n${perModel}`;
}).join("\n\n");

const readme = readFileSync("scripts/README.template.md", "utf8")
  .replaceAll("{{TOTAL}}", String(games.length - counts.films))
  .replaceAll("{{FILMS}}", String(counts.films))
  .replaceAll("{{PLAY}}", String(counts.play ?? 0))
  .replaceAll("{{DOWNLOAD}}", String(counts.download ?? 0))
  .replaceAll("{{WATCH}}", String(counts.watch ?? 0))
  .replaceAll("{{OPUS}}", String(games.filter((g) => g.model === "claude-opus-5.5" && g.kind !== "film").length))
  .replaceAll("{{ASTRA}}", String(games.filter((g) => g.model === "gpt-6-astra" && g.kind !== "film").length))
  .replace("{{SECTIONS}}", sections);
writeFileSync("README.md", readme);

const site = games.map((g) => ({
  ...g,
  model_name: MODELS[g.model],
  video: videos[g.id] ?? (existsSync(`media/${g.id}/creator.mp4`) ? `media/${g.id}/creator.mp4` : null),
  loop: existsSync(`media/${g.id}/loop.mp4`) ? `media/${g.id}/loop.mp4` : null,
  preview_start: undefined,
  rating: ratings[g.id],
  cover_at: undefined,
}));
writeFileSync("games.json", JSON.stringify(games.map((g) => g.id)));

// Link previews on X, iMessage and Slack read static meta tags, so each game gets a page that carries them and forwards to its dialog.
const SITE = "https://theolundqvist.github.io/frontier-games/";
const attr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
rmSync("g", { recursive: true, force: true });
for (const g of site) {
  mkdirSync(`g/${g.id}`, { recursive: true });
  const title = attr(`${g.title}, made by ${g.model_name}`);
  writeFileSync(`g/${g.id}/index.html`, `<!doctype html><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${attr(g.description)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Frontier Games">
<meta property="og:title" content="${title}"><meta property="og:description" content="${attr(g.description)}">
<meta property="og:url" content="${SITE}g/${g.id}/"><meta property="og:image" content="${SITE}media/${g.id}/cover.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=../../#${g.id}"><a href="../../#${g.id}">${attr(g.title)}</a>
`);
}
writeFileSync("index.html", readFileSync("scripts/index.template.html", "utf8").replace("__GAMES__", JSON.stringify(site).replaceAll("</", "<\\/")));
console.log("README.md, index.html and games.json", counts);
