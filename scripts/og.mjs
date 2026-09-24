import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { parse } from "yaml";

// The home page's link-preview card: title, tagline and the best-looking covers from each model.
const games = parse(readFileSync("data/games.yaml", "utf8"));
const ratings = parse(readFileSync("data/ratings.yaml", "utf8"));
const beauty = (g) => (ratings[g.id]?.visuals ?? 0) * 1e6 + (g.post_likes ?? 0);
const top = (m, n) => games.filter((g) => g.model === m && g.kind !== "film").sort((a, b) => beauty(b) - beauty(a)).slice(0, n);
const covers = [...top("claude-opus-5.5", 3), ...top("gpt-6-astra", 3)];
const img = (g) => `<img src="data:image/jpeg;base64,${readFileSync(`media/${g.id}/cover.jpg`).toString("base64")}">`;
const html = `<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@600&display=swap" rel="stylesheet">
<style>
body { margin: 0; width: 1200px; height: 630px; background: #EFE3C9; color: #2A1C13; font-family: Inter; display: grid; grid-template-rows: auto 1fr; }
header { padding: 36px 48px 24px; border-bottom: 3px solid #2A1C13; display: flex; justify-content: space-between; align-items: end; }
h1 { margin: 0; font: 600 64px/0.95 Fraunces; letter-spacing: -0.02em; }
p { margin: 0 0 6px; font-size: 26px; line-height: 34px; text-align: right; }
b::before { content: ""; display: inline-block; width: 14px; height: 14px; margin-right: 8px; background: var(--c); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 3px; min-height: 0; background: #2A1C13; }
.grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>
<header><h1>Frontier<br>Games</h1><p>${games.length} games and films made by<br><b style="--c:#D8742B">Claude Opus 5.5</b> and <b style="--c:#285F5D">GPT-6 Astra</b></p></header>
<div class="grid">${covers.map(img).join("")}</div>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.screenshot({ path: "og.jpg", type: "jpeg", quality: 88 });
await browser.close();
