/* SmallSky D2L API layer.
 * Every fetch uses the user's BigSky session cookie automatically because
 * the extension has host_permissions for bigsky.benilde.edu.ph.
 *
 * Endpoints proven by recon (see ../recon/out/). Versions pinned to 1.93 (LE)
 * and 1.59 (LP) — those are the latest BigSky supports as of 2026-05.
 */

export const BASE = 'https://bigsky.benilde.edu.ph';
const LE = '1.93';
const LP = '1.59';

/* Low-level JSON GET. Returns parsed body or throws.
 *
 * AUTH errors are only thrown when there's a definite signal that BigSky
 * thinks we're not logged in:
 *   - HTTP 401 or 403
 *   - The response URL is the BigSky login page (i.e. fetch followed a
 *     redirect to /d2l/login or /d2l/lp/auth/)
 *
 * Non-JSON responses on the original URL are treated as NON_JSON, not AUTH —
 * they're more likely to be a server hiccup than an auth failure, and
 * mistakenly assuming AUTH locks the user out of their cached dashboard. */
async function getJSON(path, { signal } = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await fetch(url, { credentials: 'include', signal });

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`unauthorized (${res.status})`);
    err.code = 'AUTH';
    throw err;
  }

  // Did the request get redirected to a login URL? That's the unambiguous
  // "session is gone" signal.
  if (res.url && (res.url.includes('/d2l/login') || res.url.includes('/d2l/lp/auth/login'))) {
    const err = new Error('redirected to BigSky login');
    err.code = 'AUTH';
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${path}`);
    err.code = 'HTTP';
    err.status = res.status;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    const err = new Error(`expected JSON, got ${ct || 'no content-type'} from ${path}`);
    err.code = 'NON_JSON';
    throw err;
  }
  return res.json();
}

/* ---- Global / user-level ---- */

export const whoami = () => getJSON(`/d2l/api/lp/${LP}/users/whoami`);

export const myEnrollments = () =>
  getJSON(`/d2l/api/lp/${LP}/enrollments/myenrollments/?pageSize=200`);

/* The widget API the live BigSky homepage calls — richer than enrollments
 * (gives FormattedImageLink, IsActive, Start/End dates, PinState). */
export const myCourses = () =>
  getJSON(`/d2l/le/manageCourses/api/mycourses?pageSize=100&sort=current&autoPinCourses=false&orgUnitTypeId=3&promotePins=true&embedDepth=0`);

/* Cross-course notifications (assignments due / new grades / new posts). */
export const myNotifications = (orgUnitIds) =>
  getJSON(`/d2l/le/manageCourses/api/mynotifications?orgunitIds=${orgUnitIds.join(',')}`);

/* ---- Per-course ---- */

export const courseNews     = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/news/`);
export const courseDropbox  = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/dropbox/folders/`);
export const courseQuizzes  = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/quizzes/`);
export const quizAttempts   = (ou, qid) => getJSON(`/d2l/api/le/${LE}/${ou}/quizzes/${qid}/attempts/`);
export const courseGrades   = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/grades/values/myGradeValues/`);
export const courseTOC      = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/content/toc`);
export const courseDiscussions = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/discussions/forums/`);
export const courseCalendar = (ou) => getJSON(`/d2l/api/le/${LE}/${ou}/calendar/events/`);

/* Fan-out: fetch the per-course bundle for the dashboard.
 * Runs in parallel, tolerates per-endpoint failures (returns null for failed). */
export async function courseBundle(ouId, { include = ['news', 'dropbox', 'quizzes', 'grades', 'submitted'] } = {}) {
  const tasks = {
    news:                include.includes('news')      ? courseNews(ouId)         : null,
    dropbox:             include.includes('dropbox')   ? courseDropbox(ouId)      : null,
    quizzes:             include.includes('quizzes')   ? courseQuizzes(ouId)      : null,
    grades:              include.includes('grades')    ? courseGrades(ouId)       : null,
    toc:                 include.includes('toc')       ? courseTOC(ouId)          : null,
    calendar:            include.includes('calendar')  ? courseCalendar(ouId)     : null,
    submittedFolderIds:  include.includes('submitted') ? dropboxSubmittedIds(ouId): null,
  };
  const out = {};
  await Promise.all(Object.entries(tasks).map(async ([k, p]) => {
    if (p === null) return;
    try { out[k] = await p; }
    catch (e) { out[k] = { __error: e.message, __code: e.code }; }
  }));
  return out;
}

/* Image URL helper — extension cookies attach automatically for img src.
 * LP 1.47 is the lowest version whose `/courses/{ou}/image` endpoint accepts
 * `autoSelectImage=true` without requiring an explicit width — keep this
 * pinned even though the rest of the LP API uses 1.59. */
export function courseImageUrl(ouId) {
  return `${BASE}/d2l/api/lp/1.47/courses/${ouId}/image?autoSelectImage=true`;
}

/* Submission status for a course's dropbox folders.
 *
 * Students can't list submissions via the Valence API (returns 403 — instructor
 * permission). But the user-facing /dropbox/user/folders_list.d2l HTML page
 * shows submission state: each folder with submissions has a
 * `folders_history.d2l?db={folderId}` link in the row. We fetch that page with
 * the session cookie and regex out submitted folder IDs.
 *
 * Returns: Array<string> of folder IDs the user has submitted to.
 */
export async function dropboxSubmittedIds(ouId) {
  const url = `${BASE}/d2l/lms/dropbox/user/folders_list.d2l?ou=${ouId}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for dropbox submission scrape`);
    err.code = 'HTTP';
    throw err;
  }
  // Definite auth failure = fetch ended up on the login URL after following redirects.
  // (The page itself never contains a login form when you're authenticated,
  //  so URL inspection is the reliable check.)
  if (res.url.includes('/d2l/login') || res.url.includes('/d2l/lp/auth/login')) {
    const err = new Error('not logged into BigSky');
    err.code = 'AUTH';
    throw err;
  }
  const html = await res.text();
  const ids = new Set();
  const re = /folders_history\.d2l\?db=(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

/* Direct course-page deep links used by quick-jump buttons. */
export const courseLinks = (ou) => ({
  home:        `${BASE}/d2l/home/${ou}`,
  content:     `${BASE}/d2l/le/content/${ou}/Home`,
  dropbox:     `${BASE}/d2l/lms/dropbox/user/folders_list.d2l?ou=${ou}`,
  quizzes:     `${BASE}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${ou}`,
  grades:      `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=${ou}`,
  discussions: `${BASE}/d2l/le/${ou}/discussions/List`,
  announcements: `${BASE}/d2l/lms/news/main.d2l?ou=${ou}`,
});
