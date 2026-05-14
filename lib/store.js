/* SmallSky storage wrappers — chrome.storage with TTL caching + sync-able prefs.
 *
 * .local: cached API responses (fast, big, per-machine)
 * .sync:  user prefs that should follow you across machines (pins, hides, etc.)
 *
 * D2L sends Cache-Control: no-cache + no ETag, so we own the freshness model.
 */

const LOCAL = chrome.storage.local;
const SYNC  = chrome.storage.sync;

/* Per-resource TTLs. Tuned to how often the underlying data changes. */
export const TTL = {
  whoami:       24 * 60 * 60 * 1000,   // your name never changes
  courseList:   30 * 60 * 1000,        // term rolls over rarely
  toc:          30 * 60 * 1000,        // instructors don't reshuffle weeks
  image:        24 * 60 * 60 * 1000,   // course banners are basically static
  dropbox:      10 * 60 * 1000,        // new assignments trickle in
  submitted:     1 * 60 * 1000,        // want "Submitted ✓" instantly after submit
  quizAttempts:  1 * 60 * 1000,        // same — quiz status should reflect immediately
  news:          2 * 60 * 1000,        // announcements are time-sensitive
  grades:        5 * 60 * 1000,        // posts in waves
  quizzes:      10 * 60 * 1000,        // similar to dropbox
  calendar:      5 * 60 * 1000,
  discussions:  10 * 60 * 1000,
};

/* ---- TTL cache (local) ---- */

const CACHE_PREFIX = 'cache:';

export async function cacheGet(key) {
  const wrapped = (await LOCAL.get(CACHE_PREFIX + key))[CACHE_PREFIX + key];
  if (!wrapped) return null;
  if (wrapped.expires && wrapped.expires < Date.now()) return null;
  return wrapped.value;
}

export async function cacheSet(key, value, ttlMs = 5 * 60 * 1000) {
  await LOCAL.set({
    [CACHE_PREFIX + key]: { value, expires: Date.now() + ttlMs }
  });
}

export async function cacheClear(prefix = '') {
  const all = await LOCAL.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX + prefix));
  if (keys.length) await LOCAL.remove(keys);
}

/* getOrFetch: returns cached value if fresh, else calls loader() and caches. */
export async function getOrFetch(key, loader, ttlMs) {
  const cached = await cacheGet(key);
  if (cached !== null) return { value: cached, fromCache: true };
  const value = await loader();
  await cacheSet(key, value, ttlMs);
  return { value, fromCache: false };
}

/* cached(key, fn, ttl, { swr }):
 *   - If fresh cache exists, return it.
 *   - If stale cache exists AND swr=true, return stale immediately and refresh in
 *     the background; subsequent reads will see the new value.
 *   - Else fetch fresh, cache, and return.
 *
 * Returns { value, fresh, stale } where:
 *   fresh: served from a still-valid cache or freshly fetched
 *   stale: served from an expired cache while a background refresh runs
 */
export async function cached(key, fn, ttlMs, opts = {}) {
  const wrapped = (await LOCAL.get(CACHE_PREFIX + key))[CACHE_PREFIX + key];
  const now = Date.now();
  if (wrapped) {
    if (wrapped.expires > now) {
      return { value: wrapped.value, fresh: true, stale: false };
    }
    if (opts.swr) {
      // Kick off background refresh — caller can subscribe via opts.onRefresh.
      Promise.resolve(fn()).then(async (v) => {
        await LOCAL.set({ [CACHE_PREFIX + key]: { value: v, expires: Date.now() + ttlMs } });
        if (opts.onRefresh) opts.onRefresh(v);
      }).catch(e => { if (opts.onError) opts.onError(e); });
      return { value: wrapped.value, fresh: false, stale: true };
    }
  }
  const value = await fn();
  await LOCAL.set({ [CACHE_PREFIX + key]: { value, expires: now + ttlMs } });
  return { value, fresh: true, stale: false };
}

/* ---- User prefs (sync) ---- */

const PREFS_KEY = 'prefs:v1';

const DEFAULT_PREFS = {
  pinned: [],          // [ouId, ...] — pinned to top
  hidden: [],          // [ouId, ...] — hidden from main grid
  orderOverride: {},   // ouId -> manual position (future)
  colorOverride: {},   // ouId -> palette index 1..8 (future)
  autoReplaceHome: false,    // when true, BigSky's /d2l/home auto-redirects to SmallSky
};

export async function getPrefs() {
  const got = (await SYNC.get(PREFS_KEY))[PREFS_KEY];
  return { ...DEFAULT_PREFS, ...(got || {}) };
}

export async function setPrefs(patch) {
  const cur = await getPrefs();
  const next = { ...cur, ...patch };
  await SYNC.set({ [PREFS_KEY]: next });
  return next;
}

export async function togglePin(ouId) {
  const p = await getPrefs();
  const pinned = p.pinned.includes(ouId) ? p.pinned.filter(x => x !== ouId) : [...p.pinned, ouId];
  return setPrefs({ pinned });
}

export async function toggleHidden(ouId) {
  const p = await getPrefs();
  const hidden = p.hidden.includes(ouId) ? p.hidden.filter(x => x !== ouId) : [...p.hidden, ouId];
  return setPrefs({ hidden });
}

/* ---- Custom course photos (local) ---- */

const PHOTOS_KEY = 'photos:v1';

export async function getCoursePhotos() {
  return (await LOCAL.get(PHOTOS_KEY))[PHOTOS_KEY] || {};
}

export async function setCoursePhoto(ouId, dataUrl) {
  const all = await getCoursePhotos();
  if (dataUrl) all[String(ouId)] = dataUrl;
  else delete all[String(ouId)];
  await LOCAL.set({ [PHOTOS_KEY]: all });
  return all;
}

/* ---- Class schedules (sync) ----
 * Per-course recurring weekly schedule + online-class link. Small data
 * (<100 bytes per course) that's useful across machines — kept in sync. */

const CLASS_SCHEDULES_KEY = 'classSchedules:v1';

export async function getClassSchedules() {
  return (await SYNC.get(CLASS_SCHEDULES_KEY))[CLASS_SCHEDULES_KEY] || {};
}

export async function setClassSchedule(ouId, schedule) {
  const all = await getClassSchedules();
  if (schedule) all[String(ouId)] = schedule;
  else delete all[String(ouId)];
  await SYNC.set({ [CLASS_SCHEDULES_KEY]: all });
  return all;
}

/* ---- User avatar (local) ----
 * Single dataURL string. Cosmetic only — doesn't sync to BigSky. */

const AVATAR_KEY = 'avatar:v1';

export async function getAvatar() {
  return (await LOCAL.get(AVATAR_KEY))[AVATAR_KEY] || null;
}

export async function setAvatar(dataUrl) {
  if (dataUrl) await LOCAL.set({ [AVATAR_KEY]: dataUrl });
  else await LOCAL.remove(AVATAR_KEY);
  return dataUrl || null;
}

/* ---- Notes (local, per assignment) ---- */

const NOTES_KEY = 'notes:v1';

export async function getNotes() {
  return (await LOCAL.get(NOTES_KEY))[NOTES_KEY] || {};
}

export async function setNote(assignmentId, text) {
  const notes = await getNotes();
  if (text && text.trim()) notes[assignmentId] = text;
  else delete notes[assignmentId];
  await LOCAL.set({ [NOTES_KEY]: notes });
  return notes;
}

/* ---- Read-state (local, for announcements / grades) ---- */

const READ_KEY = 'read:v1';

export async function getRead() {
  return (await LOCAL.get(READ_KEY))[READ_KEY] || {};
}

export async function markRead(id) {
  const read = await getRead();
  read[id] = Date.now();
  await LOCAL.set({ [READ_KEY]: read });
  return read;
}
