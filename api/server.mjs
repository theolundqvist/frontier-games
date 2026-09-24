import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DATA = process.env.DATA_DIR ?? "/data";
const PORT = Number(process.env.PORT ?? 8080);
const GAMES_URL = process.env.GAMES_URL ?? "https://theolundqvist.github.io/frontier-games/games.json";
const ORIGINS = new Set((process.env.CORS_ORIGINS ?? "https://theolundqvist.github.io").split(","));
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const LIMITS = {
  votesPerIpHour: 120,
  votersPerIpDay: 30,
  commentsPerIp10Min: 5,
  commentsPerIpDay: 30,
};

mkdirSync(`${DATA}/backups`, { recursive: true });
if (!existsSync(`${DATA}/salt`)) writeFileSync(`${DATA}/salt`, randomBytes(32).toString("hex"));
const salt = readFileSync(`${DATA}/salt`, "utf8");

const db = new DatabaseSync(`${DATA}/frontier.db`);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS votes (
    game TEXT NOT NULL, voter TEXT NOT NULL, ip TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (game, voter)
  );
  CREATE INDEX IF NOT EXISTS votes_voter ON votes (voter);
  CREATE INDEX IF NOT EXISTS votes_ip ON votes (ip, created_at);
  CREATE TABLE IF NOT EXISTS vote_events (ip TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS vote_events_ip ON vote_events (ip, created_at);
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, voter TEXT NOT NULL, ip TEXT NOT NULL,
    name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_game ON comments (game, id);
  CREATE INDEX IF NOT EXISTS comments_ip ON comments (ip, created_at);
`);

const q = {
  stats: db.prepare(`SELECT game, SUM(v) AS votes, SUM(c) AS comments FROM (
    SELECT game, 1 AS v, 0 AS c FROM votes UNION ALL SELECT game, 0, 1 FROM comments) GROUP BY game`),
  voterVotes: db.prepare("SELECT game FROM votes WHERE voter = ?"),
  hasVote: db.prepare("SELECT 1 FROM votes WHERE game = ? AND voter = ?"),
  addVote: db.prepare("INSERT INTO votes (game, voter, ip, created_at) VALUES (?, ?, ?, ?)"),
  removeVote: db.prepare("DELETE FROM votes WHERE game = ? AND voter = ?"),
  countVotes: db.prepare("SELECT COUNT(*) AS n FROM votes WHERE game = ?"),
  voteEvent: db.prepare("INSERT INTO vote_events (ip, created_at) VALUES (?, ?)"),
  ipVoteEvents: db.prepare("SELECT COUNT(*) AS n FROM vote_events WHERE ip = ? AND created_at > ?"),
  ipVoters: db.prepare("SELECT COUNT(DISTINCT voter) AS n FROM votes WHERE ip = ? AND created_at > ?"),
  voterSeenOnIp: db.prepare("SELECT 1 FROM votes WHERE ip = ? AND voter = ? LIMIT 1"),
  comments: db.prepare("SELECT id, name, body, created_at FROM comments WHERE game = ? ORDER BY id"),
  addComment: db.prepare("INSERT INTO comments (game, voter, ip, name, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, body, created_at"),
  ipComments: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE ip = ? AND created_at > ?"),
  pruneEvents: db.prepare("DELETE FROM vote_events WHERE created_at < ?"),
};

let games = new Set();
async function loadGames() {
  const res = await fetch(GAMES_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`games.json ${res.status}`);
  games = new Set(await res.json());
}

function backup() {
  const day = new Date().toISOString().slice(0, 10);
  const file = `${DATA}/backups/frontier-${day}.db`;
  if (!existsSync(file)) db.exec(`VACUUM INTO '${file}'`);
  readdirSync(`${DATA}/backups`).sort().slice(0, -14).forEach((f) => rmSync(`${DATA}/backups/${f}`));
  q.pruneEvents.run(Date.now() - DAY);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashIp = (req) => createHash("sha256").update(salt + (req.headers["x-real-ip"] ?? req.socket.remoteAddress)).digest("hex").slice(0, 32);

function requireGame(game) {
  if (!games.has(game)) throw new HttpError(404, "That game isn't in the gallery.");
  return game;
}
function requireVoter(voter) {
  if (!UUID.test(String(voter))) throw new HttpError(400, "Missing browser id. Reload the page and try again.");
  return voter;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, "That's too long.");
  }
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "Invalid request."); }
}

const routes = {
  "GET /health": () => ({ ok: true, games: games.size }),
  "GET /stats": () => Object.fromEntries(q.stats.all().map((r) => [r.game, { votes: r.votes, comments: r.comments }])),
  "GET /voter/:id": (req, id) => ({ votes: q.voterVotes.all(requireVoter(id)).map((r) => r.game) }),
  "GET /comments/:id": (req, id) => q.comments.all(requireGame(id)),
  "POST /vote": async (req) => {
    const { game, voter } = await readJson(req);
    requireGame(game); requireVoter(voter);
    const ip = hashIp(req), now = Date.now();
    if (q.ipVoteEvents.get(ip, now - HOUR).n >= LIMITS.votesPerIpHour) throw new HttpError(429, "Too many votes from your network. Try again in an hour.");
    const voted = !q.hasVote.get(game, voter);
    if (voted) {
      if (!q.voterSeenOnIp.get(ip, voter) && q.ipVoters.get(ip, now - DAY).n >= LIMITS.votersPerIpDay) throw new HttpError(429, "Too many voters from your network today.");
      q.addVote.run(game, voter, ip, now);
    } else {
      q.removeVote.run(game, voter);
    }
    q.voteEvent.run(ip, now);
    return { votes: q.countVotes.get(game).n, voted };
  },
  "POST /comments": async (req) => {
    const { game, voter, name = "", body = "" } = await readJson(req);
    requireGame(game); requireVoter(voter);
    const text = String(body).trim(), who = String(name).trim();
    if (!text) throw new HttpError(400, "Write something first.");
    if (text.length > 2000) throw new HttpError(400, "Keep comments under 2,000 characters.");
    if (who.length > 40) throw new HttpError(400, "Keep your name under 40 characters.");
    if ((text.match(/https?:\/\//g) ?? []).length > 2) throw new HttpError(400, "Comments can include at most two links.");
    const ip = hashIp(req), now = Date.now();
    if (q.ipComments.get(ip, now - 10 * 60_000).n >= LIMITS.commentsPerIp10Min || q.ipComments.get(ip, now - DAY).n >= LIMITS.commentsPerIpDay) {
      throw new HttpError(429, "You're commenting fast. Try again in a few minutes.");
    }
    return q.addComment.get(game, voter, ip, who, text, now);
  },
};

function route(req) {
  const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";
  const [, head, param] = path.match(/^(\/[^/]+)(?:\/([^/]+))?$/) ?? [];
  return routes[`${req.method} ${head}${param ? "/:id" : ""}`]?.bind(null, req, param && decodeURIComponent(param));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
  if (ORIGINS.has(origin)) Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" });
  if (req.method === "OPTIONS") return res.writeHead(204, headers).end();
  try {
    const handler = route(req);
    if (!handler) throw new HttpError(404, "Not found.");
    res.writeHead(200, headers).end(JSON.stringify(await handler()));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    res.writeHead(e.status ?? 500, headers).end(JSON.stringify({ error: e instanceof HttpError ? e.message : "Something went wrong on our side." }));
  }
});

await loadGames();
setInterval(() => loadGames().catch((e) => console.error("games refresh failed:", e.message)), 10 * 60_000);
backup();
setInterval(backup, HOUR);
server.listen(PORT, () => console.log(`frontier api on :${PORT} with ${games.size} games`));
