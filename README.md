# recipecard

A recipe link or a photo goes in. The list of things to buy comes out, on a
3×5 index card that fits in your pocket.

Give it a recipe **URL**, a **photo** of a recipe (a cookbook page, a card, a
screenshot), or **pasted text** - one input, no mode to choose: lines that are
links are fetched, anything else is read as the recipe, and photos arrive by
paste, drag-and-drop, or the Add photo button. It produces a shopping-list
card that:

- **Converts kitchen measures into shopping amounts.** Cups, sticks, ounces
  and pounds become grams, millilitres, or a number of things to pick up.
  Anything with an exact answer ("6 oz noodles", "1½ cups flour", "2 cups
  stock") is converted by local arithmetic with a built-in density table.
- **Uses Claude for the conversions that need judgement.** "2 cups diced
  tomatoes" becomes "2 medium tomatoes (~300 g)" - the model decides what a
  shopper actually buys, and its numbers are cross-checked against the local
  converter wherever both can answer.
- **Explains varieties.** If the recipe calls for a specific variety, cut or
  grade (russet, San Marzano, Arborio, chuck), it scans the whole recipe for
  the reason and prints it on the card - "baked, needs floury/starchy" - with
  suitable alternatives and their trade-offs. If the recipe names no variety
  but the choice matters, it recommends one and says why. Anything inferred
  rather than read is marked **assumed**.
- **Merges and sorts.** Duplicate ingredients are combined (across several
  recipes, if you give it more than one), and the card is ordered roughly
  the way you walk a shop. Cupboard staples (salt, oil, common spices) go on
  their own kraft-coloured card so you check before you buy.

The card is editable in place: click a name or amount to correct it (swap
sugar for honey, say), and every line has three controls - edit, move to the
cupboard card (a reminder to check, not a purchase) and remove (with undo).
Add items by hand, and tap the circle to tick things off while you shop. Cards can be named (or rename one by clicking its
title), and every card you make is kept in a **Card Archive** in your browser
(localStorage) - reopen, keep editing, print, or delete any of them later.
Print puts each card on a 3in x 5in page; you can also copy the list as plain
text or download it as JSON.

## Setup

Requires Node 20+ and an [Anthropic API key](https://console.anthropic.com/settings/keys)
in the `ANTHROPIC_API_KEY` environment variable - the page never asks for it.

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

Optional environment variables: `PORT` (default 3000) and `CLAUDE_MODEL`
(default `claude-opus-5`).

## Deploying

**Vercel** - works zero-config: `public/` is served as the static site and
`api/build.js` runs the API as a serverless function (`server.js` is not used
there). Set `ANTHROPIC_API_KEY` under Project Settings -> Environment
Variables, then redeploy. `vercel.json` asks for a 300 s function timeout,
which needs Fluid compute (on by default for new projects); if your project
predates it and the deploy complains, lower `maxDuration` to 60. Vercel also
caps request bodies at ~4.5 MB - photos are downscaled in the browser first,
so this rarely matters, but very many photos in one build may not fit.

**Any Node host** - `npm start` runs `server.js`, which serves both the site
and the API from one process.

## How it works

```
URL ──► fetch + schema.org/Recipe (JSON-LD) extraction ─┐
photo ──► downscaled in the browser, sent as image ──────┤
text ────────────────────────────────────────────────────┤
                                                         ▼
                    Claude (structured output: items, varieties,
                    reasons, alternatives, staples, source lines)
                                                         ▼
                    deterministic reconciliation (src/units.js):
                    exact unit/density conversions recomputed
                    locally and overriding the model's arithmetic
                                                         ▼
                              the index card
```

- `src/extract.js` - fetches recipe pages (public addresses only), prefers
  JSON-LD structured data, falls back to stripped page text.
- `src/units.js` - fraction/unit parsing, imperial→metric conversion, and a
  grams-per-cup density table for common ingredients.
- `src/prompt.js` - the system prompt and the JSON schema the model fills in.
- `src/claude.js` - the API call, keyed from the environment (structured
  outputs + server-side refusal
  fallbacks, with a plain-JSON retry if those betas aren't on your key).
- `src/reconcile.js` - merges the model's judgement with the local arithmetic;
  items whose numbers were verified locally are marked `checked` in the JSON.

## Honest limitations

- Weights for produce are shopping estimates, not scale readings.
- Some recipe sites sit behind bot shields (Cloudflare and friends) that
  block all server-side fetching with HTTP 403 - they fingerprint the TLS
  handshake, so no header can help. Two user-agents are tried, then the
  Internet Archive's copy of the page; if neither works, the error says so -
  paste the recipe text or add a screenshot instead.
- Photo reading is as good as the photo - unreadable lines are flagged in the
  warnings rather than guessed silently.
- A build can take a minute or two on a long recipe. The server holds the
  connection open with whitespace heartbeats (legal JSON padding) so proxies
  and tunnels don't cut it off mid-thought.
