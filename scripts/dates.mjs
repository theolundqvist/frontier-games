import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";

const file = "data/games.yaml";
const doc = parseDocument(readFileSync(file, "utf8"));
const only = process.argv.slice(2);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function posted(g) {
  if (g.post_url?.includes("/status/")) {
    const id = g.post_url.split("/status/")[1].split(/[/?]/)[0];
    const tweet = (await (await fetch(`https://api.fxtwitter.com/i/status/${id}`)).json()).tweet;
    if (tweet) return day(tweet.created_timestamp * 1000);
  }
  const gist = /^https:\/\/gist\.github\.com\/[^/]+\/(\w+)/.exec(g.repo_url ?? "")?.[1];
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/.exec(g.repo_url ?? "")?.[1];
  if (gist || repo) {
    const created = execFileSync("gh", ["api", gist ? `gists/${gist}` : `repos/${repo}`, "--jq", ".created_at"]).toString().trim();
    if (created) return created.slice(0, 10);
  }
  const added = execFileSync("git", ["log", "--reverse", "--format=%cs", "-S", `id: ${g.id}\n`, "--", file]).toString().split("\n")[0];
  return added || day(Date.now());
}

for (const item of doc.contents.items) {
  const g = item.toJSON();
  if (only.length && !only.includes(g.id)) continue;
  const date = await posted(g).catch((e) => { console.log(`skip ${g.id}: ${e.message.split("\n")[0]}`); return null; });
  if (!date) continue;
  if (date !== g.date) console.log(g.id, g.date ?? "-", "->", date);
  item.set("date", date);
}
writeFileSync(file, doc.toString({ lineWidth: 0 }));
