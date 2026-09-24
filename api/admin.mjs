import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);
const [command, arg] = process.argv.slice(2);

if (command === "comments") {
  for (const c of await sql`SELECT id, game, name, body, created_at FROM comments ORDER BY id DESC LIMIT ${Number(arg ?? 50)}`) {
    console.log(`#${c.id} ${c.created_at.toISOString()} ${c.game} ${c.name}: ${c.body.replace(/\s+/g, " ").slice(0, 160)}`);
  }
} else if (command === "delete-comment") {
  console.log((await sql`DELETE FROM comments WHERE id = ${Number(arg)}`).count ? `deleted #${arg}` : `no comment #${arg}`);
} else {
  console.log("usage: node admin.mjs comments [limit] | delete-comment <id>");
}
await sql.end();
