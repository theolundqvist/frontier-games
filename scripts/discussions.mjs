import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parse } from "yaml";

const REPO_ID = "R_kgDOUn8FqA";
const CATEGORY_ID = "DIC_kwDOUn8FqM4DGQmI";
const token = process.env.GITHUB_TOKEN ?? execSync("gh auth token").toString().trim();
const games = parse(readFileSync("data/games.yaml", "utf8"));

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const found = new Map();
for (let after = null; ; ) {
  const { repository } = await graphql(
    `query($after: String) { repository(owner: "theolundqvist", name: "frontier-games") {
      discussions(first: 100, after: $after, categoryId: "${CATEGORY_ID}") {
        pageInfo { hasNextPage endCursor }
        nodes { number body reactions(content: THUMBS_UP) { totalCount } comments { totalCount } }
      } } }`,
    { after },
  );
  for (const d of repository.discussions.nodes) {
    const id = d.body.match(/<!-- game:(\S+) -->/)?.[1];
    if (id) found.set(id, { discussion: d.number, votes: d.reactions.totalCount, comments: d.comments.totalCount });
  }
  if (!repository.discussions.pageInfo.hasNextPage) break;
  after = repository.discussions.pageInfo.endCursor;
}

for (const g of games.filter((g) => !found.has(g.id))) {
  const links = [["Play", g.play_url], ["Watch", g.watch_url], ["Download", g.download_url], ["Source", g.repo_url], ["Original post", g.post_url]]
    .filter(([, url]) => url).map(([label, url]) => `[${label}](${url})`).join(" · ");
  const body = `${g.description}\n\n${links}\n\n[Open in the gallery](https://theolundqvist.github.io/frontier-games/#${g.id})\n\n<!-- game:${g.id} -->`;
  const { createDiscussion } = await graphql(
    `mutation($input: CreateDiscussionInput!) { createDiscussion(input: $input) { discussion { number } } }`,
    { input: { repositoryId: REPO_ID, categoryId: CATEGORY_ID, title: g.title, body } },
  );
  found.set(g.id, { discussion: createDiscussion.discussion.number, votes: 0, comments: 0 });
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`created #${createDiscussion.discussion.number} ${g.id}`);
}

writeFileSync("data/votes.json", JSON.stringify(Object.fromEntries(found), null, 1));
console.log(`${found.size} discussions`);
