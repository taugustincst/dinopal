# Virtual pet

A small, original virtual pet you look after in the browser. An egg hatches into a dinosaur that grows, evolves into one of
three adult forms depending on how well you cared for it, plays a guessing game with you and does things on its own. It
is a single self-contained page with no network access and no build step.

This example is not part of the `software-factory` npm package (`examples/` is not in `files`). The dinosaur, its forms,
names and art are original, not a recreation of any commercial product.

## Play

Open `index.html` directly (double-click it, or open `file:///path/to/examples/virtual-pet/index.html`). Any static file
host works too. Progress is saved in your browser's `localStorage` under `virtual-pet.v1`. If the browser blocks storage
(some private modes or `file://` setups), the game still works until you close the page and says so on screen.

## Rules

- Name your pet (1-20 characters). It starts as an egg at hunger 80, happiness 80, energy 80, health 100.
- Every 60 seconds is one tick, or one game minute. Awake: hunger −5, happiness −3, energy −2. Asleep: hunger −2,
  energy +10.
- After each tick, health drops 10 if hunger, happiness or energy is 0, and rises 5 if all three are at least 50.
- **Stages** come from the pet's age in game minutes: Egg (under 5 min), Hatchling (5 min to under 2 h), Juvenile (2 h to
  under 24 h) and Adult (24 h and older). The egg wobbles and cracks in its final minute. Each stage is drawn larger.
- **Care score**: on every Juvenile tick where hunger, happiness, energy and health all end at 50 or more, the tick counts
  as good. On the tick it turns Adult, the pet evolves once, for good: **Sunback** (70% or more good ticks), **Spikeback**
  (40% or more) or **Grumblesaur** (below 40%).
- **Feed**: hunger +25. **Sleep/Wake** toggles sleep. Feed and Play are disabled while asleep.
- **Play** opens "Which way?": 5 rounds, each with the pet hiding behind the Left or Right bush. 3 or more correct
  guesses give happiness +20, fewer give +5, and the game costs 10 energy either way. Closing the game early changes
  nothing. Play is disabled, with the reason shown below the buttons, for an Egg, a sleeping or dead pet, and below 10
  energy.
- **Behaviours**: a hatched, awake pet picks a new behaviour every 10-20 seconds: yawn (energy below 30), sulk (happiness
  below 30), stomp (happiness 70 or more) or sniff around. A caption describes it, but it is not announced to screen
  readers. Feed, Play and Sleep trigger a short chomp, hop or curl-up reaction (1.5 s) that never blocks the buttons.
- Hatching, evolving, game results and death are announced in the live region.
- Mood is sad when any stat is below 30, happy when happiness and health are both at least 60, and neutral otherwise.
- At health 0 the pet dies. "Start over" deletes the save and asks for a new name.
- Time away counts: on reload, missed ticks are applied, capped at 24 hours (1440 ticks). A pet survives a workday
  unattended, but not a weekend.

## Saves and migration

Saves carry `version: 2` and the care counters (`juvenileTicks`, `goodTicks`) and `form`. The storage key is still
`virtual-pet.v1` so old saves are found. A save without `version` is from the first version of the pet and is moved by
its old stage name to the start of the matching new stage: Egg stays an Egg, Baby becomes a 5-minute Hatchling, Child
becomes a 2-hour Juvenile whose care score starts from now, and Adult becomes a 24-hour Adult Spikeback. Name and stats
are kept, but an old pet can lose some age (a Child of 9 h restarts at 2 h). Any other version or corrupt data starts a
new egg.

## Editing

All game rules live in `rules.mjs` and are unit tested in `test/virtual-pet-rules.test.js`. Browsers refuse to import
modules over `file://`, so `index.html` contains a verbatim copy of `rules.mjs` inside its single inline
`<script type="module">`, between these lines:

```
// BEGIN rules.mjs (verbatim copy; checked by test/virtual-pet-page.test.js)
// END rules.mjs
```

All motion is CSS that changes only `transform` and `opacity`. The page script switches it on with `data-*` attributes
on `#pet-figure` (`data-stage`, `data-form`, `data-wobble`, `data-event`, `data-behaviour`, `data-reaction`). Under
`prefers-reduced-motion: reduce` every animation is off, and the static poses (cracks, shell shards, an open jaw, a raised
or curled body) stay because they are plain attribute rules.

After changing `rules.mjs` or anything in the page's `<script>` or `<style>`:

1. Paste the new `rules.mjs` between the markers.
2. Run `node --test test/virtual-pet-page.test.js`. If the CSP hashes no longer match, the failure message prints the
   expected `'sha256-…'` value; paste it into the `Content-Security-Policy` meta tag.
3. Run `npm run lint` and `npm test`.

`index.html` is listed in `.prettierignore` because reformatting it would change the hashed bytes.

## Manual checks

The tests cover the rules, the page glue in a fake DOM and the page's markup statically. Before a release, also check in
current Chrome, Firefox and Safari:

- Open the page via `file://` with DevTools set to offline. The Network panel shows only the document, and the console
  shows no CSP errors.
- Walk a pet from Egg to Adult offline by editing the save's `ticks` and `lastUpdated` and reloading: `ticks` 4 shows the
  wobbling, cracked egg; one minute later it hatches with shell shards and "hatched!" in the status line. Then try ticks
  119 and 1439 (with `juvenileTicks` 10 and `goodTicks` 8, 5 or 1 for each form) to see the Juvenile, the evolution and
  the Sunback, Spikeback and Grumblesaur art. No network requests appear at any point.
- Turn on reduced motion in DevTools (Rendering → Emulate CSS `prefers-reduced-motion: reduce`). Nothing moves, but the
  cracks, shards, reactions, captions and announcements still appear.
- Play "Which way?" with the keyboard only: Tab to Play, press Enter, choose Left or Right in each round, close the game
  and check focus returns to Play.
- Set `localStorage['virtual-pet.v1'] = '{bad'` and reload. The naming view appears with no console error. Try an old
  save without `version` (ticks 0, 60, 180, 600) to see each migration.
- Edit the save to `"health":10,"hunger":0` with an old `lastUpdated` and reload to see the death screen. "Start over"
  removes the key.
- Tab through every control: each shows a visible focus ring and works with Enter or Space.
- At 360 px responsive width, `document.documentElement.scrollWidth <= 360` (no horizontal scrolling).
