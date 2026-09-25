# X discovery run

You are running unattended in the frontier-games repo. Find new, genuinely impressive videos, motion design, animations, music videos and short films that **Claude Opus 5.5** made, and add the ones that clear the bar to the gallery.

## Search

Search X posts from the last 7 days (WebSearch with `site:x.com`, several phrasings: "Opus 5.5" animation, motion design, music video, short film, three.js, Remotion, hyperframes, shader, Blender, "made this video", "one-shot", "didn't write a line"). Follow quote-posts and replies of hits. Read every candidate through `https://api.fxtwitter.com/i/status/<id>` (text, likes, date, video) and the linked repo or page. Skip anything whose post URL is already in `data/games.yaml` or `discover/seen.yaml`.

## The bar

Add an entry only when all hold:

1. **The builder names Claude Opus 5.5** in the post, repo or page. Earlier Claude models, "Claude" with no version, and mixed-model builds stay out.
2. **More or less completely Claude-made.** Every frame comes from code Claude wrote or tools it drove (Canvas, three.js, shaders, Remotion, hyperframes, Blender, p5.js). AI music is fine. Image, video or 3D generator art (Midjourney, Veo, Kling, Sora, TRELLIS, Meshy) and asset packs stay out.
3. **Runway exception:** a film Claude directed end to end where Runway generated the footage is allowed, with `made_with: runway`. Any other generator stays out.
4. **It is striking.** Would a motion designer stop scrolling? Real craft, not a demo loop, a logo spin or a slideshow.
5. **Footage exists**: the post carries a video.

Record every candidate you rejected in `discover/seen.yaml` as `<post_url>: <short reason>` so later runs skip it.

## Add

For each accepted film, append an entry to `data/games.yaml` in the style of the existing `kind: film` entries (id, kind: film, title, model: claude-opus-5.5, tier: watch, creator_name, creator_handle, post_url, post_likes, date from the post, repo_url when public, engine, genre, runtime, build, description in two plain sentences, model_evidence quoting the builder verbatim, and `made_with: runway` when it applies). Then:

```sh
npm run media -- <ids>
npm run videos -- <ids>
node scripts/pick-moments.mjs <ids>
node scripts/rate.mjs <ids>     # writes frame sheets; look at them and add ratings to data/ratings.yaml like existing film entries
node scripts/rate.mjs --finalize
npm run build
```

Look at every generated `media/<id>/cover.jpg` yourself; a cover showing browser chrome, a title card or a black frame gets a better `cover_at`.

## Publish

Commit only the files this run changed, with message `Discovery: <titles>` and no trailers, then `git push`. Git identity is already configured; never change it. If nothing cleared the bar, commit only `discover/seen.yaml`.

Finish by printing one line per accepted entry (`title, creator, likes, gallery URL`) and a count of rejected candidates.
