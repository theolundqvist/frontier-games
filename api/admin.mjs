import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(`${process.env.DATA_DIR ?? "/data"}/frontier.db`);
const [command, arg] = process.argv.slice(2);

if (command === "comments") {
  for (const c of db.prepare("SELECT id, game, name, body, datetime(created_at / 1000, 'unixepoch') AS at FROM comments ORDER BY id DESC LIMIT ?").all(Number(arg ?? 50))) {
    console.log(`#${c.id} ${c.at} ${c.game} ${c.name || "Anonymous"}: ${c.body.replace(/\s+/g, " ").slice(0, 160)}`);
  }
} else if (command === "delete-comment") {
  console.log(db.prepare("DELETE FROM comments WHERE id = ?").run(Number(arg)).changes ? `deleted #${arg}` : `no comment #${arg}`);
} else {
  console.log("usage: node admin.mjs comments [limit] | delete-comment <id>");
}
