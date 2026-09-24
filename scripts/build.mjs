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

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-|-$/g, "");
const site = games.map((g) => ({
  ...g,
  model_name: MODELS[g.model],
  creator: slug(g.creator_handle ?? g.creator_name),
  video: videos[g.id] ?? (existsSync(`media/${g.id}/creator.mp4`) ? `media/${g.id}/creator.mp4` : null),
  loop: existsSync(`media/${g.id}/loop.mp4`) ? `media/${g.id}/loop.mp4` : null,
  preview_start: undefined,
  rating: ratings[g.id],
  cover_at: undefined,
}));
writeFileSync("games.json", JSON.stringify(games.map((g) => g.id)));
writeFileSync("data.js", `export default ${JSON.stringify(site)};\n`);

// Every game and creator gets its own URL with its own meta tags, so search results and link previews show that page's content.
const SITE = "https://theolundqvist.github.io/frontier-games/";
const TAGLINE = "The best games and films made by Claude Opus 5.5 and GPT-6 Astra, with play links, full footage, votes and comments.";
const attr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const json = (o) => JSON.stringify(o).replaceAll("</", "<\\/");
const person = (g) => ({ "@type": "Person", name: g.creator_name, ...(g.creator_handle && { url: `https://x.com/${g.creator_handle}` }) });
const byName = (g) => (g.creator_handle ? "@" + g.creator_handle : g.creator_name);

function head({ path, title, description, image, ld }) {
  return [
    `<base href="${"../".repeat(path.split("/").length - 1) || "./"}">`,
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(description)}">`,
    `<link rel="canonical" href="${SITE}${path}">`,
    `<meta property="og:type" content="website"><meta property="og:site_name" content="Frontier Games">`,
    `<meta property="og:title" content="${attr(title)}"><meta property="og:description" content="${attr(description)}">`,
    `<meta property="og:url" content="${SITE}${path}"><meta property="og:image" content="${SITE}${image}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${json({ "@context": "https://schema.org", ...ld })}</script>`,
  ].filter(Boolean).join("\n");
}

const template = readFileSync("scripts/index.template.html", "utf8");
const page = (file, meta, route) => {
  mkdirSync(file.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(file, template.replace("__HEAD__", head(meta)).replace("__ROUTE__", JSON.stringify(route)));
};

const byDate = [...site].sort((a, b) => b.date.localeCompare(a.date));
page("index.html", {
  path: "", title: "Frontier Games: the best games made by Claude Opus 5.5 and GPT-6 Astra", description: TAGLINE, image: "og.jpg",
  ld: { "@type": "CollectionPage", name: "Frontier Games", description: TAGLINE, url: SITE,
    mainEntity: { "@type": "ItemList", numberOfItems: site.length, itemListElement: byDate.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}g/${g.id}/`, name: g.title })) } },
}, null);

rmSync("g", { recursive: true, force: true });
rmSync("c", { recursive: true, force: true });
for (const g of site) {
  page(`g/${g.id}/index.html`, {
    path: `g/${g.id}/`, title: `${g.title}, made by ${g.model_name} | Frontier Games`, description: g.description, image: `media/${g.id}/cover.jpg`,
    ld: { "@type": g.kind === "film" ? "Movie" : "VideoGame", name: g.title, description: g.description, url: `${SITE}g/${g.id}/`,
      image: `${SITE}media/${g.id}/cover.jpg`, datePublished: g.date, author: person(g), ...(g.genre && { genre: g.genre }),
      ...(g.kind !== "film" && g.play_url && { gamePlatform: "Web browser" }), ...(g.post_url && { sameAs: g.post_url }) },
  }, { game: g.id });
}
const creators = Map.groupBy(site, (g) => g.creator);
for (const [key, list] of creators) {
  const g = list[0], n = list.length;
  const models = [...new Set(list.map((x) => x.model_name))].join(" and ");
  page(`c/${key}/index.html`, {
    path: `c/${key}/`, title: `${byName(g)}: ${n} ${n === 1 ? "entry" : "entries"} made with ${models} | Frontier Games`,
    description: `${list.map((x) => x.title).join(", ")}. Made by ${g.creator_name} with ${models}.`, image: `media/${[...list].sort((a, b) => (b.post_likes ?? 0) - (a.post_likes ?? 0))[0].id}/cover.jpg`,
    ld: { "@type": "ProfilePage", name: byName(g), url: `${SITE}c/${key}/`, mainEntity: person(g) },
  }, { creator: key });
}

const urls = [["", byDate[0].date], ...byDate.map((g) => [`g/${g.id}/`, g.date]), ...[...creators].map(([k, l]) => [`c/${k}/`, l.map((x) => x.date).sort().at(-1)])];
writeFileSync("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, d]) => `<url><loc>${SITE}${u}</loc><lastmod>${d}</lastmod></url>`).join("\n")}\n</urlset>\n`);
console.log("README.md, index.html, data.js, sitemap.xml,", site.length, "game pages,", creators.size, "creator pages", counts);
