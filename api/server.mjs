import { createServer } from "node:http";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import postgres from "postgres";

const PORT = Number(process.env.PORT ?? 8080);
const GAMES_URL = process.env.GAMES_URL ?? "https://theolundqvist.github.io/frontier-games/games.json";
const ORIGINS = new Set((process.env.CORS_ORIGINS ?? "https://theolundqvist.github.io").split(","));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SESSION_DAYS = 180;
const LIMITS = {
  votesPerIpHour: 120,
  votersPerIpDay: 30,
  commentsPerUser10Min: 5,
  commentsPerUserDay: 30,
};

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    name TEXT NOT NULL, picture TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS votes (
    game TEXT NOT NULL, voter UUID NOT NULL, ip TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (game, voter)
  );
  CREATE INDEX IF NOT EXISTS votes_voter ON votes (voter);
  CREATE INDEX IF NOT EXISTS votes_ip ON votes (ip, created_at);
  CREATE TABLE IF NOT EXISTS vote_events (ip TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS vote_events_ip ON vote_events (ip, created_at);
  CREATE TABLE IF NOT EXISTS comments (
    id BIGSERIAL PRIMARY KEY, game TEXT NOT NULL, user_id BIGINT REFERENCES users ON DELETE SET NULL,
    name TEXT NOT NULL, picture TEXT, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS comments_game ON comments (game, id);
  CREATE INDEX IF NOT EXISTS comments_user ON comments (user_id, created_at);
`);
await sql`INSERT INTO settings VALUES ('ip_salt', ${randomBytes(32).toString("hex")}) ON CONFLICT DO NOTHING`;
const [{ value: salt }] = await sql`SELECT value FROM settings WHERE key = 'ip_salt'`;

let games = new Set();
async function loadGames() {
  const res = await fetch(GAMES_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`games.json ${res.status}`);
  games = new Set(await res.json());
}

let googleKeys = { keys: new Map(), expires: 0 };
async function googleKey(kid) {
  if (Date.now() > googleKeys.expires || !googleKeys.keys.has(kid)) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    const maxAge = Number(res.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] ?? 3600);
    const { keys } = await res.json();
    googleKeys = { keys: new Map(keys.map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })])), expires: Date.now() + maxAge * 1000 };
  }
  return googleKeys.keys.get(kid);
}

async function verifyGoogleCredential(credential) {
  const parts = String(credential).split(".");
  if (parts.length !== 3) throw new HttpError(400, "Google sign-in failed. Try again.");
  let header, payload;
  try { [header, payload] = parts.slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url"))); }
  catch { throw new HttpError(400, "Google sign-in failed. Try again."); }
  const key = header.alg === "RS256" && (await googleKey(header.kid));
  const valid = key && verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  const fresh = payload.exp * 1000 > Date.now();
  const ours = payload.aud === GOOGLE_CLIENT_ID && ["accounts.google.com", "https://accounts.google.com"].includes(payload.iss);
  if (!valid || !fresh || !ours || !payload.email_verified) throw new HttpError(401, "Google sign-in failed. Try again.");
  return payload;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashIp = (req) => createHash("sha256").update(salt + (req.headers["x-real-ip"] ?? req.socket.remoteAddress)).digest("hex").slice(0, 32);
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const publicUser = (u) => ({ name: u.name, picture: u.picture });

function requireGame(game) {
  if (!games.has(game)) throw new HttpError(404, "That game isn't in the gallery.");
  return game;
}
function requireVoter(voter) {
  if (!UUID.test(String(voter))) throw new HttpError(400, "Missing browser id. Reload the page and try again.");
  return voter;
}
async function currentUser(req) {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  const [user] = await sql`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()`;
  return user ?? null;
}
async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, "Sign in with Google to comment.");
  return user;
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
  "GET /health": async () => ({ ok: true, games: games.size, db: (await sql`SELECT 1 AS ok`)[0].ok === 1 }),
  "GET /stats": async () => {
    const rows = await sql`SELECT game, SUM(v)::int AS votes, SUM(c)::int AS comments FROM (
      SELECT game, 1 AS v, 0 AS c FROM votes UNION ALL SELECT game, 0, 1 FROM comments) t GROUP BY game`;
    return Object.fromEntries(rows.map((r) => [r.game, { votes: r.votes, comments: r.comments }]));
  },
  "GET /voter/:id": async (req, id) => ({ votes: (await sql`SELECT game FROM votes WHERE voter = ${requireVoter(id)}`).map((r) => r.game) }),
  "GET /comments/:id": (req, id) => sql`SELECT id, name, picture, body, created_at FROM comments WHERE game = ${requireGame(id)} ORDER BY id`,
  "POST /vote": async (req) => {
    const { game, voter } = await readJson(req);
    requireGame(game); requireVoter(voter);
    const ip = hashIp(req);
    return sql.begin(async (tx) => {
      const [{ n: events }] = await tx`SELECT count(*)::int AS n FROM vote_events WHERE ip = ${ip} AND created_at > now() - interval '1 hour'`;
      if (events >= LIMITS.votesPerIpHour) throw new HttpError(429, "Too many votes from your network. Try again in an hour.");
      const removed = await tx`DELETE FROM votes WHERE game = ${game} AND voter = ${voter} RETURNING 1`;
      if (!removed.length) {
        const [{ n: voters }] = await tx`SELECT count(DISTINCT voter)::int AS n FROM votes WHERE ip = ${ip} AND voter <> ${voter} AND created_at > now() - interval '1 day'`;
        if (voters >= LIMITS.votersPerIpDay) throw new HttpError(429, "Too many voters from your network today.");
        await tx`INSERT INTO votes (game, voter, ip) VALUES (${game}, ${voter}, ${ip})`;
      }
      await tx`INSERT INTO vote_events (ip) VALUES (${ip})`;
      const [{ n: votes }] = await tx`SELECT count(*)::int AS n FROM votes WHERE game = ${game}`;
      return { votes, voted: !removed.length };
    });
  },
  "POST /auth/google": async (req) => {
    const { credential } = await readJson(req);
    const g = await verifyGoogleCredential(credential);
    const [user] = await sql`INSERT INTO users (google_sub, email, name, picture)
      VALUES (${g.sub}, ${g.email}, ${g.name ?? g.email.split("@")[0]}, ${g.picture ?? null})
      ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
      RETURNING *`;
    const token = randomBytes(32).toString("base64url");
    await sql`INSERT INTO sessions VALUES (${hashToken(token)}, ${user.id}, now() + ${`${SESSION_DAYS} days`}::interval)`;
    return { token, user: publicUser(user) };
  },
  "GET /me": async (req) => {
    const user = await currentUser(req);
    return { user: user && publicUser(user) };
  },
  "POST /logout": async (req) => {
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    return { ok: true };
  },
  "POST /comments": async (req) => {
    const user = await requireUser(req);
    const { game, body = "" } = await readJson(req);
    requireGame(game);
    const text = String(body).trim();
    if (!text) throw new HttpError(400, "Write something first.");
    if (text.length > 2000) throw new HttpError(400, "Keep comments under 2,000 characters.");
    if ((text.match(/https?:\/\//g) ?? []).length > 2) throw new HttpError(400, "Comments can include at most two links.");
    const [{ recent, today }] = await sql`SELECT
      count(*) FILTER (WHERE created_at > now() - interval '10 minutes')::int AS recent, count(*)::int AS today
      FROM comments WHERE user_id = ${user.id} AND created_at > now() - interval '1 day'`;
    if (recent >= LIMITS.commentsPerUser10Min || today >= LIMITS.commentsPerUserDay) throw new HttpError(429, "You're commenting fast. Try again in a few minutes.");
    const [comment] = await sql`INSERT INTO comments (game, user_id, name, picture, body)
      VALUES (${game}, ${user.id}, ${user.name}, ${user.picture}, ${text}) RETURNING id, name, picture, body, created_at`;
    return comment;
  },
};

function route(req) {
  const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";
  if (routes[`${req.method} ${path}`]) return routes[`${req.method} ${path}`].bind(null, req);
  const [, head, param] = path.match(/^(\/[^/]+)\/([^/]+)$/) ?? [];
  return routes[`${req.method} ${head}/:id`]?.bind(null, req, decodeURIComponent(param));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
  if (ORIGINS.has(origin)) Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" });
  if (req.method === "OPTIONS") return res.writeHead(204, headers).end();
  try {
    const handler = route(req);
    if (!handler) throw new HttpError(404, "Not found.");
    const body = JSON.stringify(await handler());
    res.writeHead(200, headers).end(body);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    res.writeHead(e.status ?? 500, headers).end(JSON.stringify({ error: e instanceof HttpError ? e.message : "Something went wrong on our side." }));
  }
});

await loadGames();
setInterval(() => loadGames().catch((e) => console.error("games refresh failed:", e.message)), 10 * 60_000);
const logError = (e) => console.error(e);
setInterval(() => sql`DELETE FROM vote_events WHERE created_at < now() - interval '1 day'`.catch(logError), HOUR);
setInterval(() => sql`DELETE FROM sessions WHERE expires_at < now()`.catch(logError), DAY);
server.listen(PORT, () => console.log(`frontier api on :${PORT} with ${games.size} games`));
