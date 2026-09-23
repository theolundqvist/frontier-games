import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const games = parse(readFileSync("data/games.yaml", "utf8"));
const only = process.argv.slice(2);
const targets = games.filter((g) => (g.play_url ?? g.watch_url) && (only.length ? only.includes(g.id) : !existsSync(`media/${g.id}/cover.png`)));

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const g of targets) {
  mkdirSync(`media/${g.id}`, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(g.play_url ?? g.watch_url, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `media/${g.id}/cover.png`, timeout: 90000 });
    console.log(`ok ${g.id}`);
  } catch (e) {
    console.log(`FAIL ${g.id}: ${e.message.split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
