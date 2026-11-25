# Dino Pal — Virtual Pet

An original virtual pet game: an egg hatches into a dinosaur that grows,
evolves into one of three adult forms depending on how well you cared for it,
plays a guessing game with you and does things on its own. Fully offline —
no network, no accounts, no ads.

- **The game** is a single self-contained page at
  [examples/virtual-pet/index.html](examples/virtual-pet/index.html); all
  rules live in `examples/virtual-pet/rules.mjs` and are unit-tested in
  `test/`. See [examples/virtual-pet/README.md](examples/virtual-pet/README.md)
  for how to play and the editing rules (the page embeds a verbatim copy of
  `rules.mjs` and a CSP hash that must stay in sync — the tests enforce both).
- **Run the tests:** `npm test`
- **The Android app** (`android/`) is a minimal WebView shell that bundles
  the game page from `examples/virtual-pet/` at build time and loads it from
  the app's own assets. Package: `com.augustinnovations.dinopal`.
- **Release:** run the "Release (Play bundle)" workflow from the Actions tab
  with a version number; it builds the bundle, checks the APK with
  `tools/check-apk.js`, and attaches the signed `.aab` to a GitHub Release
  tagged `play-v<version>` (signed when the repo's `ANDROID_UPLOAD_*` secrets
  are set).
