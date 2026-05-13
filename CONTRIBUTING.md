# Contributing to SmallSky

Hi! Whether you're a Benilde student who wants to fix something that bugs you, a designer who has thoughts on the tile layout, or a dev who wants to add a feature — pull requests are very welcome.

## Quick start

```bash
git clone https://github.com/Nyrrine/smallsky.git
cd smallsky
```

That's it — no build step. Vanilla HTML/CSS/JS with ES modules.

To test changes:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick the folder.
4. Click the cute cloud icon to open the dashboard.
5. After any code change, hit the **↻ reload** on the extension card + close/reopen the dashboard tab.

## How the code is organized

```
.
├── manifest.json           # extension config (MV3)
├── background.js           # service worker — chrome.alarms, badge updates
├── content.js / .css       # injected into BigSky pages (launcher pill, favicon swap, auto-redirect)
├── dashboard.html          # the dashboard page entry
├── dashboard.css           # all dashboard styling
├── dashboard.js            # the dashboard orchestrator — state, render, event wiring
├── lib/
│   ├── api.js              # typed D2L Valence API fetchers
│   ├── store.js            # chrome.storage wrappers (TTL caching, prefs, notes)
│   ├── derive.js           # view-model builders (Up Next, What's New, Schedule)
│   ├── search.js           # cross-course substring search
│   ├── icons.js            # inline SVG icons (Lucide-style)
│   └── queue.js            # concurrency limiter for fan-out fetches
└── assets/
    ├── smallsky-icon.png   # the cute cloud + moon, master icon source
    ├── smallsky-mark.svg   # the bubble-letter wordmark (used in greeting)
    └── icon-{16,32,48,128,256}.png  # rendered from the master icon
```

## Conventions

- **No build step.** Native ES modules only — `<script type="module">`. Keep it that way.
- **No inline event handlers.** Chrome MV3 CSP forbids them. Always use `addEventListener`.
- **HTML-escape user-provided data** before injecting via `innerHTML`. There's a shared `escapeHtml()` helper.
- **Sanitize D2L announcement HTML** with `sanitizeAnnouncementHtml()` — strips `<script>`, `<iframe>`, and event handlers.
- **Cache everything with TTLs.** New API calls should go through `lib/store.js#cached()` with a reasonable TTL — see `lib/store.js#TTL` for the existing tiers.
- **Use the concurrency limiter** for any fan-out across courses to avoid hammering BigSky.

## Where help is wanted

- ⌘K command palette (the only feature still on the queue)
- Multi-day event spans in the schedule (assignments with a start + end visible as a bar)
- iCal export of upcoming items
- Custom themes (pastel palettes, sticker packs)
- Better D2L API recon — there may be more useful endpoints we haven't discovered yet (see `recon/` in earlier history)
- Translations (Filipino especially)

### Accessibility — especially this

SmallSky has real gaps for students who use assistive tech. I'd love help closing them, but more importantly: **if you're a student who relies on a screen reader, keyboard navigation, high-contrast / larger text, reduced motion, voice control, switch access, or any other accommodation — please reach out and tell me what would make SmallSky usable for you.**

I can't fix what I don't know about. Even a one-line "this part doesn't work with [tool]" message helps me prioritize. Reach out on [Discord](https://discord.gg/DTvRR5qxxh), [open an issue](https://github.com/Nyrrine/smallsky/issues), or DM me directly — whichever's easiest for you. PRs from anyone working in accessibility are very welcome.

## Filing bugs

[GitHub Issues](https://github.com/Nyrrine/smallsky/issues) for code bugs. The [Discord](https://discord.gg/DTvRR5qxxh) for "is this broken or am I" questions, feature ideas, and general chat.

When reporting a bug, helpful info:
- Chrome version (`chrome://version`)
- SmallSky version (in Settings → About)
- What course / page you were on
- Console errors (`F12` → Console tab)

## Pull request flow

1. Fork the repo.
2. Create a branch: `git checkout -b feat/your-feature` or `fix/your-bug`.
3. Make the change. Test by loading the unpacked extension locally.
4. Commit with a sentence saying *why*, not just *what*.
5. Open a PR against `main`. Describe what it does and how to test.

PRs are reviewed for:
- Doesn't break existing features
- Respects the soft, calm aesthetic (no harsh colors, no info overload)
- Reasonable performance — feature should still feel instant at first paint
- No new dependencies unless very justified

## CI checks (run automatically on every push + PR)

Three workflows live in `.github/workflows/`:

- **`lint.yml`** — JSON validity, JS syntax (`node --check`), and a check that every file referenced by `manifest.json` actually exists on disk. Fast and minimal — no eslint or prettier overhead.
- **`manifest-sync.yml`** — verifies `manifest.json#version` and `version.json#version` are identical. If they drift, the in-extension update notifier would mislead users.
- **`release.yml`** — triggers only on `v*` tag pushes. Builds a clean distribution zip (excludes `.git`, `.github`, `recon`), creates a GitHub Release with auto-generated changelog, attaches the zip as a release asset.

Regular pushes only run the first two (read-only validators). The release workflow never fires unless you explicitly push a version tag.

## Release process

For when you're ready to ship a new version:

```bash
# 1. Bump both manifest.json and version.json in one shot
python3 tools/bump-version.py 1.1.0 "Added ⌘K palette" "Fixed dark mode toast"

# 2. Commit + push the version bump
git add manifest.json version.json
git commit -m "Release v1.1.0"
git push

# 3. Tag and push the tag — this fires the release workflow
git tag v1.1.0 -m "SmallSky v1.1.0"
git push origin v1.1.0
```

The `release.yml` action picks it up from there:
- Checks out the tagged commit
- Builds `smallsky-v1.1.0.zip` (with the right exclusions)
- Verifies nothing sensitive made it into the archive
- Creates a GitHub Release with the tag
- Attaches the zip as an asset

Within 24 hours, every installed SmallSky's daily update check sees the new `version.json`, flags `available: true`, and shows the soft banner on the dashboard. Users click "See what's new" → modal with the changelog you passed to `bump-version.py` → 3-step update guide.

If you want to push an update to users *faster than 24 hours*, just tell them in Discord — they can hit **Settings → Data → Check now** to pull the new banner immediately.

## What this project is *not* trying to be

- A replacement for BigSky itself. We don't reimplement quiz-taking, file uploads, gradebook editing. We're a reader, an organizer, a calm landing page.
- An LMS for non-Benilde schools. The codebase is tightly coupled to BigSky's D2L tenant — adapting it to another D2L instance is possible but explicit work, not configuration.
- A money-making thing. It will always be free.

Thanks for reading this far.
