<div align="center">

<img src="assets/icon-256.png" width="140" alt="SmallSky">

# SmallSky

**A friendlier dashboard for BigSky (D2L Brightspace) at De La Salle-CSB.**

[![Discord](https://img.shields.io/badge/Discord-Join_support-5865F2?logo=discord&logoColor=white)](https://discord.gg/DTvRR5qxxh)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-7B68EE)](https://github.com/Nyrrine/smallsky/releases)

</div>

---

## What it does

BigSky (Benilde's D2L Brightspace) is functional but harsh — eight clicks to find what's due, no glance-able view of new announcements, no cross-course search, and an interface that hasn't been updated in years.

**SmallSky** is a Chrome extension that reads from BigSky's own APIs and renders it as a soft, calm dashboard. Built specifically for Benilde students.

It's not a replacement for BigSky — submissions, content viewing, quizzes still happen on BigSky itself. SmallSky is the *home page*, the *agenda view*, the *finder*.

## Features

- **Up Next** — the four most urgent unsubmitted assignments and quizzes, with real submission detection (scrapes the dropbox HTML since the API doesn't expose student submission state).
- **My classes** — a tile grid for every course you're enrolled in. Pin to top, hide admin courses, upload custom photos. Click a tile to see modules / weeks / recent announcements without leaving the dashboard.
- **What's new** — recent announcements with inline expand. Mark-as-read tracked locally.
- **Schedule** — full month calendar of every dated event across all your courses, with a day-by-day agenda. Submitted assignments are dimmed; missed ones (past submission window) are flagged.
- **Cross-course search** — press <kbd>/</kbd> to fuzzy-search announcements, modules, assignments, and quizzes — all instant, no extra fetches.
- **Background sync + Chrome badge** — service worker pings BigSky every 5 minutes; toolbar icon shows count of items due in 48 hours.
- **Light / dark theme** — circle-reveal animation between modes.
- **Per-assignment notes** — local-only scratchpad on every Up Next card.
- **Auto-open SmallSky** — optional: BigSky's `/d2l/home` redirects to SmallSky.

## Install (for now: as an unpacked extension)

1. Click `Code` → `Download ZIP` (or `git clone`).
2. Unzip the folder.
3. Open Chrome and navigate to `chrome://extensions`.
4. Toggle **Developer mode** on (top right).
5. Click **Load unpacked** and pick the unzipped folder.
6. Pin the SmallSky icon to your toolbar.
7. Log into BigSky in any tab — then click the icon.

## Privacy

- SmallSky runs entirely in your browser. **Nothing leaves your device.**
- It reads from BigSky's APIs using your existing session cookies — the same way the BigSky web UI does.
- Cached data, custom photos, notes, and preferences all live in `chrome.storage`, scoped to your browser profile.
- No analytics, no telemetry, no external servers.

## Tech

- Manifest V3 Chrome extension. Vanilla ES modules — no build step.
- Service worker for background sync (`chrome.alarms`).
- `chrome.storage.local` for caches (TTL'd, stale-while-revalidate). `chrome.storage.sync` for preferences (pins, hides, settings).
- HTML-scrapes one D2L endpoint (`dropbox/user/folders_list.d2l`) for student-side submission state, which the Valence API gates behind instructor permission.

## Author

Made by **Joaquin Bryan G. Ross** · ID 125
DLS-CSB

Found a bug, want a feature, or just to say hi? [Join the Discord](https://discord.gg/DTvRR5qxxh) or [open an issue](https://github.com/Nyrrine/smallsky/issues).

## License

[MIT](LICENSE), with a disclaimer that SmallSky is unofficial and may show inaccurate data — always verify on BigSky itself before relying on it for graded work.
