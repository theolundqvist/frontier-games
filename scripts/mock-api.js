const params = new URLSearchParams(location.search);
const mode = params.get("mockapi");
const wait = (value, ms = 120) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const fail = (error, status) => Promise.reject(Object.assign(new Error(error), { status }));
const user = { name: "Theo Lundqvist", picture: null };
let signedIn = mode === "signedin";
if (signedIn) localStorage.setItem("fg-token", "mock-token");
const votes = { "paperboy-browser-remake": 41, "turbo-kart-rally": 12, "storm-race": 7 };
const mine = new Set(["storm-race"]);
const comments = {
  "paperboy-browser-remake": [
    { id: 1, name: "Maya Chen", picture: null, body: "The dog chase is genuinely tense. Beat it on the second try.", created_at: "2026-09-21T10:00:00Z" },
    { id: 2, name: "Jonas", picture: null, body: "Runs at 60 fps on a 2019 laptop.\nThrow arc feels great.", created_at: "2026-09-22T12:00:00Z" },
  ],
};

export default {
  stats: () => mode === "offline" ? fail("offline") : wait(Object.fromEntries(Object.keys({ ...votes, ...comments }).map((id) => [id, { votes: votes[id] ?? 0, comments: comments[id]?.length ?? 0 }]))),
  voted: () => wait({ votes: [...mine] }),
  play: () => true,
  vote: (game) => {
    mine.has(game) ? mine.delete(game) : mine.add(game);
    votes[game] = (votes[game] ?? 0) + (mine.has(game) ? 1 : -1);
    return wait({ votes: votes[game], voted: mine.has(game) });
  },
  comments: (game) => wait(comments[game] ?? []),
  comment: (game, body) => {
    if (!signedIn || body.includes("expire")) { signedIn = false; return fail("Your session expired. Sign in again to comment.", 401); }
    if (body.includes("spam")) return fail("You are commenting too fast. Wait a minute and try again.", 429);
    const c = { id: Date.now(), ...user, body, created_at: new Date().toISOString() };
    (comments[game] ??= []).push(c);
    return wait(c);
  },
  signIn: () => { signedIn = true; return wait({ token: "mock-token", user }); },
  me: () => wait({ user: signedIn ? user : null }),
  signOut: () => { signedIn = false; return wait({}); },
  googleButton: async (el, onCredential) => {
    el.innerHTML = `<button type="button" class="btn">Sign in with Google (mock)</button>`;
    el.firstChild.addEventListener("click", () => onCredential("mock-credential"));
  },
};
