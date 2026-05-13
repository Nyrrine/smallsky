/* SmallSky background service worker.
 *
 * Responsibilities:
 *   - Open the dashboard when the toolbar icon is clicked
 *   - Run a periodic sync (every 5 min via chrome.alarms) that:
 *       • refreshes the course list + each course's hot data
 *       • computes the count of assignments due in the next 48h (not submitted)
 *       • updates the Chrome action badge to show that number
 *       • writes fresh data into the same cache keys the dashboard reads from,
 *         so opening the dashboard is instant
 */

import * as api from './lib/api.js';
import * as store from './lib/store.js';
import { makeLimiter } from './lib/queue.js';

const DASHBOARD_URL = chrome.runtime.getURL('dashboard.html');
const ALARM_NAME = 'smallsky-sync';
const SYNC_INTERVAL_MINUTES = 5;
const DUE_HORIZON_MS = 48 * 60 * 60 * 1000;  // 48 hours
const NEW_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const URGENT_COLOR  = '#B86F47'; // matches --urgent
const NEUTRAL_COLOR = '#5B4FB8'; // matches --accent

const limit = makeLimiter(6);

/* ---- toolbar click ---- */

chrome.action.onClicked.addListener(async () => {
  const existing = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
});

/* ---- alarm lifecycle ---- */

chrome.runtime.onInstalled.addListener(async () => {
  console.log('SmallSky installed.');
  await ensureAlarm();
  // Don't wait — kick off an immediate sync so the badge is meaningful on first install.
  runSync().catch(e => console.warn('initial sync failed:', e.message));
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await runSync().catch(e => console.warn('sync failed:', e.message));
});

/* ---- sync routine ---- */

async function runSync() {
  const startedAt = Date.now();

  // Refresh the course list. Cache it under the key the dashboard reads.
  let mc;
  try {
    mc = await api.myCourses();
    await store.cacheSet('mycourses', mc, store.TTL.courseList);
  } catch (e) {
    if (e.code === 'AUTH') {
      // Not logged in — silently clear the badge so it doesn't lie.
      await setBadge(null);
      return;
    }
    throw e;
  }
  const courses = (mc.Courses || []).filter(c => c.CanAccessCourse && c.IsActive);

  // Refresh per-course hot data (news + dropbox + submitted IDs). Cache each.
  // Skip quizzes/grades/toc here — they're loaded on dashboard open with SWR.
  let dueCount = 0;
  let newAnnounceCount = 0;
  const now = Date.now();
  const dueBy = now + DUE_HORIZON_MS;
  const newSince = now - NEW_HORIZON_MS;

  await Promise.all(courses.map(c => limit(async () => {
    const ou = c.OrgUnitId;
    let news = [], dropbox = [], submitted = [];
    try { news = await api.courseNews(ou); await store.cacheSet(`news:${ou}`, news, store.TTL.news); } catch {}
    try { dropbox = await api.courseDropbox(ou); await store.cacheSet(`dropbox:${ou}`, dropbox, store.TTL.dropbox); } catch {}
    try { submitted = await api.dropboxSubmittedIds(ou); await store.cacheSet(`submitted:${ou}`, submitted, store.TTL.submitted); } catch {}

    const subSet = new Set((submitted || []).map(String));
    for (const f of dropbox || []) {
      if (!f.DueDate) continue;
      if (subSet.has(String(f.Id))) continue;
      // Skip folders where the submission window has already closed —
      // they're no longer actionable, don't badge them.
      const endDate = f.Availability && f.Availability.EndDate;
      if (endDate && new Date(endDate).getTime() < now) continue;
      const t = new Date(f.DueDate).getTime();
      if (t >= now && t <= dueBy) dueCount++;
    }
    for (const n of news || []) {
      const t = new Date(n.LastModifiedDate || n.CreatedDate).getTime();
      if (t >= newSince) newAnnounceCount++;
    }
  })));

  // Update the badge.
  await setBadge({ due: dueCount, newAnnounce: newAnnounceCount });

  // Save last-sync state so the dashboard can show "synced 2m ago"
  await store.cacheSet('lastSync', {
    at: Date.now(),
    durationMs: Date.now() - startedAt,
    dueCount,
    newAnnounceCount,
  }, 24 * 60 * 60 * 1000);
}

async function setBadge(counts) {
  if (!counts) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Open SmallSky — sign in to BigSky to sync' });
    return;
  }
  const { due, newAnnounce } = counts;
  if (due > 0) {
    await chrome.action.setBadgeText({ text: String(Math.min(due, 99)) });
    await chrome.action.setBadgeBackgroundColor({ color: URGENT_COLOR });
  } else if (newAnnounce > 0) {
    await chrome.action.setBadgeText({ text: '•' });
    await chrome.action.setBadgeBackgroundColor({ color: NEUTRAL_COLOR });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
  const parts = [];
  if (due > 0) parts.push(`${due} due in 48h`);
  if (newAnnounce > 0) parts.push(`${newAnnounce} new announcement${newAnnounce === 1 ? '' : 's'}`);
  await chrome.action.setTitle({
    title: parts.length ? `SmallSky — ${parts.join(' · ')}` : 'SmallSky — all caught up',
  });
}

/* ---- message channel: dashboard can ask for an immediate sync ---- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'sync-now') {
    runSync().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;   // async response
  }
});
