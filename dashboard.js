/* SmallSky dashboard — live data orchestrator.
 * Imports the API + derive + storage layers and renders the page.
 *
 * Loading strategy:
 *   1. Render cached data immediately (fast first paint)
 *   2. Kick off live fetches in background
 *   3. Re-render with fresh data when each chunk lands
 *   4. Show inline error toast if not logged in
 */

import * as api from './lib/api.js';
import * as store from './lib/store.js';
import * as derive from './lib/derive.js';
import { ICONS } from './lib/icons.js';
import { makeLimiter } from './lib/queue.js';
import { search as searchAll } from './lib/search.js';
import { checkForUpdate, getUpdateStatus, getDismissedVersion, dismissUpdate } from './lib/updater.js';

const TTL = store.TTL;
const fetchLimit = makeLimiter(6);  // max 6 concurrent fetches to BigSky

/* Per-resource cached fetcher with concurrency cap. */
function cachedFetch(key, fn, ttl, opts = {}) {
  return store.cached(key, () => fetchLimit(fn), ttl, opts);
}

/* Load (or background-refresh) one course's full bundle.
 *
 * Each piece has its own TTL so we don't refetch slow-changing data when only
 * fast-changing data has expired. swr=true means stale data renders instantly
 * while the network refresh runs in parallel. */
async function loadCourseBundle(ouId, { swr = true, onPartial = null } = {}) {
  const ks = (n) => `${n}:${ouId}`;
  // Map cache key name → bundle property name (some differ).
  const BUNDLE_KEY = { news: 'news', dropbox: 'dropbox', quizzes: 'quizzes', grades: 'grades', submitted: 'submittedFolderIds' };
  const fire = (cacheName) => (v) => {
    if (onPartial) onPartial(ouId, BUNDLE_KEY[cacheName], v);
  };

  const [news, dropbox, quizzes, grades, submitted] = await Promise.all([
    cachedFetch(ks('news'),      () => api.courseNews(ouId),     TTL.news,      { swr, onRefresh: fire('news') }),
    cachedFetch(ks('dropbox'),   () => api.courseDropbox(ouId),  TTL.dropbox,   { swr, onRefresh: fire('dropbox') }),
    cachedFetch(ks('quizzes'),   () => api.courseQuizzes(ouId),  TTL.quizzes,   { swr, onRefresh: fire('quizzes') }),
    cachedFetch(ks('grades'),    () => api.courseGrades(ouId),   TTL.grades,    { swr, onRefresh: fire('grades') }),
    cachedFetch(ks('submitted'), () => api.dropboxSubmittedIds(ouId), TTL.submitted, { swr, onRefresh: fire('submitted') }),
  ]);

  return {
    news: news.value,
    dropbox: dropbox.value,
    quizzes: quizzes.value,
    grades: grades.value,
    submittedFolderIds: submitted.value,
  };
}

/* ---- DOM helpers ---- */
const $ = (sel) => document.querySelector(sel);
const html = (str) => str; // (no-op, marker for readability)

/* ---- top-level state ---- */
const _today = new Date();
const state = {
  me: null,
  courses: [],          // raw mycourses
  bundles: {},          // ouId -> { news, dropbox, quizzes, grades, ... }
  prefs: { pinned: [], hidden: [], colorOverride: {} },
  photos: {},           // ouId -> dataURL of custom course photo
  notes: {},            // taskId -> note text
  hiddenExpanded: false,
  scheduleYear: _today.getFullYear(),
  scheduleMonth: _today.getMonth(),
  scheduleSelected: derive_dayKey(_today),
  err: null,
};
function derive_dayKey(d) {
  // mirrors derive.dayKey — used before derive module is imported in some paths
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ---- bootstrap ---- */

init().catch(e => {
  console.error('SmallSky boot failed:', e);
  showError(e.message || 'Unexpected error.');
});

async function init() {
  initTheme();
  renderTopbar();
  renderGreeting('…');
  wireGlobalEvents();

  // Prefs (pin/hide) + custom photos + notes + read-state — load immediately so first render reflects them.
  [state.prefs, state.photos, state.notes, state._read] = await Promise.all([
    store.getPrefs(), store.getCoursePhotos(), store.getNotes(), store.getRead(),
  ]);

  // Update banner: render any cached status immediately, then kick off a
  // fresh check in the background (don't block first paint).
  state.updateStatus = await getUpdateStatus();
  state.updateDismissed = await getDismissedVersion();
  renderUpdateBanner();
  checkForUpdate().then(async () => {
    state.updateStatus = await getUpdateStatus();
    renderUpdateBanner();
  }).catch(() => {});

  try {
    // swr=true: every layer serves stale cache instantly and refreshes in
    // the background. First paint never blocks on the network.
    await refreshAll({ swr: true });
  } catch (e) {
    state.err = e;
    if (e.code === 'AUTH') {
      // Only lock the user out if we have nothing to show. With any cached
      // whoami/courses we can still render the dashboard with a "lapsed
      // session" banner — much friendlier than a hard redirect.
      const hasCache = !!(await store.cacheGet('whoami'));
      if (!hasCache) {
        showLoggedOutScreen();
        return;
      }
      showError('BigSky session may have lapsed — showing cached data. Click refresh to retry.');
    } else if (e.code === 'NON_JSON') {
      showError(`BigSky returned an unexpected response. Click refresh to retry.`);
    } else {
      showError(`Couldn't reach BigSky: ${e.message}`);
    }
  }
  render();
}

async function refreshAll({ swr = true } = {}) {
  // Top-level resources, each with its own TTL.
  const [meR, mcR, enrollR] = await Promise.all([
    cachedFetch('whoami', () => api.whoami(),         TTL.whoami,     { swr, onRefresh: v => { state.me = v; render(); } }),
    cachedFetch('mycourses', () => api.myCourses(),   TTL.courseList, { swr, onRefresh: () => scheduleReRender() }),
    cachedFetch('enrollments', () => api.myEnrollments(), TTL.courseList, { swr, onRefresh: () => scheduleReRender() }),
  ]);
  state.me = meR.value;

  // Build last-accessed map from enrollments (still useful for sort order).
  const accessMap = {};
  for (const it of (enrollR.value.Items || [])) {
    if (it.OrgUnit && it.Access && it.Access.LastAccessed) {
      accessMap[String(it.OrgUnit.Id)] = it.Access.LastAccessed;
    }
  }

  // Filter to active accessible courses, merge LastAccessed.
  const courses = (mcR.value.Courses || [])
    .filter(c => c.CanAccessCourse && c.IsActive)
    .map(c => ({ ...c, LastAccessed: accessMap[String(c.OrgUnitId)] || null }));
  state.courses = courses;

  // Render tiles immediately (no per-course data yet — preview will say "loading…"-ish).
  render();

  // Per-course bundles — fan out with concurrency cap, render as each lands.
  const bundles = { ...state.bundles };
  await Promise.all(courses.map(async (c) => {
    try {
      const b = await loadCourseBundle(c.OrgUnitId, {
        swr,
        // When a background SWR refresh lands fresh data, splice it into
        // state.bundles and re-render — otherwise the UI keeps showing stale
        // values forever after the first paint.
        onPartial: (id, key, value) => {
          if (!state.bundles[id]) state.bundles[id] = {};
          state.bundles[id][key] = value;
          scheduleReRender();
        },
      });
      bundles[c.OrgUnitId] = { ...(bundles[c.OrgUnitId] || {}), ...b };
      state.bundles = bundles;
      render();
    } catch (e) {
      console.warn('bundle failed for', c.OrgUnitId, e);
    }
  }));

  // Warm TOCs in the background so cross-course search can include module names.
  // Idle-style: low priority, no rendering changes.
  warmAllTOCs(courses);
}

async function warmAllTOCs(courses) {
  for (const c of courses) {
    const ouId = c.OrgUnitId;
    if (state.bundles[ouId]?.toc) continue;
    try {
      const r = await store.cached(`toc:${ouId}`, () => fetchLimit(() => api.courseTOC(ouId)), TTL.toc, { swr: true });
      state.bundles[ouId] = { ...(state.bundles[ouId] || {}), toc: r.value };
    } catch { /* tolerate */ }
  }
}

/* Coalesces several SWR refresh signals into one render per animation frame. */
let _rafScheduled = false;
function scheduleReRender() {
  if (_rafScheduled) return;
  _rafScheduled = true;
  requestAnimationFrame(() => { _rafScheduled = false; render(); });
}

/* ---- rendering ---- */

function renderTopbar() {
  $('[data-action="settings"]').innerHTML = ICONS.settings;
  $('[data-action="bell"]').insertAdjacentHTML('afterbegin', ICONS.bell);
  $('#search-icon-slot').innerHTML = ICONS.search;
  refreshThemeIcon();
}

function refreshThemeIcon() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  $('[data-action="theme"]').innerHTML = isDark ? ICONS.sun : ICONS.moon;
}

function renderGreeting(name) {
  const period = derive.greeting();
  const first = name && name !== '…' ? name.split(' ')[0] : '…';
  const cap = first === '…' ? '…' : first.charAt(0) + first.slice(1).toLowerCase();
  $('#greeting-headline').textContent = `Good ${period}, ${cap}.`;
  // Sub-line: tasks due soon + new announcements
  const upcoming = state._upNext ? state._upNext.length : 0;
  const newAnnounce = state._feed ? state._feed.filter(f => f.kind === 'announcement').length : 0;
  if (state.courses.length === 0) {
    $('#greeting-sub').textContent = 'Welcome to SmallSky.';
  } else {
    const parts = [];
    parts.push(upcoming === 1 ? '1 thing due soon' : `${upcoming} things due soon`);
    if (newAnnounce > 0) parts.push(newAnnounce === 1 ? '1 announcement' : `${newAnnounce} announcements`);
    $('#greeting-sub').textContent = `You have ${parts.join(' and ')}.`;
  }
}

function render() {
  const firstName = state.me ? state.me.FirstName : '…';
  renderGreeting(firstName);

  // Avatar initials
  if (state.me) {
    const initials = (state.me.FirstName[0] || '') + (state.me.LastName[0] || '');
    const avatar = $('.avatar');
    avatar.textContent = initials.toUpperCase();
    avatar.setAttribute('aria-label', `${state.me.FirstName} ${state.me.LastName}`);
  }


  // Compose view models
  const arranged = derive.arrangeCourses(state.courses.map(stringIds), state.prefs);
  const visibleCourses = [...arranged.pins, ...arranged.main];
  // Up Next = active todos only. Submitted items disappear from this list
  // (you've done them — they're no longer "up next").
  state._upNext = derive.buildUpNext(visibleCourses, state.bundles, { withinDays: 21, includeSubmitted: false }).slice(0, 4);
  state._feed   = derive.buildFeed(visibleCourses, state.bundles, { limit: 10 });

  renderUpNext(state._upNext);
  renderCourses(arranged);
  renderFeed(state._feed);
  renderSchedule();
  updateBellBadge();
}

/* ---- Schedule render ---- */

function renderSchedule() {
  const events = derive.buildSchedule(state.courses, state.bundles);
  const year = state.scheduleYear;
  const month = state.scheduleMonth;
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#schedule-month-label').textContent = monthLabel;

  // Build cells
  const todayKey = derive.dayKey(new Date());
  const days = derive.monthDays(year, month);
  const wkHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const grid = $('#schedule-calendar');
  grid.innerHTML = `
    <div class="cal-weekheader">${wkHeaders.map(d => `<div>${d}</div>`).join('')}</div>
    <div class="cal-grid">
      ${days.map(d => {
        const key = derive.dayKey(d);
        const inMonth = d.getMonth() === month;
        const isToday = key === todayKey;
        const isSelected = key === state.scheduleSelected;
        const evs = events[key] || [];
        const visible = evs.slice(0, 3);
        const more = evs.length - visible.length;
        return `
          <button class="cal-cell${inMonth ? '' : ' cal-cell--out'}${isToday ? ' cal-cell--today' : ''}${isSelected ? ' cal-cell--selected' : ''}"
                  data-day="${key}">
            <span class="cal-date">${d.getDate()}</span>
            ${visible.length ? `
              <div class="cal-events">
                ${visible.map(ev => {
                  const ci = derive.colorIndex(ev.courseCode);
                  return `
                    <span class="cal-chip chip-c${ci}${ev.submitted ? ' is-done' : ''}${ev.closed ? ' is-closed' : ''}" title="${escapeHtml(ev.courseCode)} — ${escapeHtml(ev.title)}">
                      <span class="cal-chip-icon">${ICONS[ev.icon] || ICONS.bell}</span>
                      <span class="cal-chip-text">${escapeHtml(ev.title)}</span>
                    </span>
                  `;
                }).join('')}
                ${more > 0 ? `<span class="cal-more">+${more} more</span>` : ''}
              </div>
            ` : ''}
          </button>
        `;
      }).join('')}
    </div>
  `;

  // Click handler for day cells
  grid.querySelectorAll('.cal-cell').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.day;
      const [y, m] = key.split('-').map(Number);
      state.scheduleSelected = key;
      // If user clicks a day in prev/next month, jump there too.
      if (m - 1 !== state.scheduleMonth) {
        state.scheduleYear = y;
        state.scheduleMonth = m - 1;
      }
      renderSchedule();
    });
  });

  // Agenda
  renderAgenda(events[state.scheduleSelected] || [], state.scheduleSelected);
}

function renderAgenda(events, dayStr) {
  const agenda = $('#schedule-agenda');
  const pretty = derive.prettyDay(dayStr);
  const sub = (() => {
    const d = new Date(dayStr + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  })();

  if (!events.length) {
    agenda.innerHTML = `
      <div class="agenda-head">
        <div class="agenda-day">${escapeHtml(pretty)}</div>
        <div class="agenda-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="agenda-empty">Nothing scheduled.</div>
    `;
    return;
  }

  const byKind = { announcement: [], assignment: [], quiz: [] };
  for (const e of events) (byKind[e.kind] || (byKind[e.kind] = [])).push(e);

  const sections = [
    { kind: 'announcement', label: 'Announcements', items: byKind.announcement },
    { kind: 'assignment',   label: 'Assignments',   items: byKind.assignment },
    { kind: 'quiz',         label: 'Quizzes',       items: byKind.quiz },
  ].filter(s => s.items.length);

  agenda.innerHTML = `
    <div class="agenda-head">
      <div class="agenda-day">${escapeHtml(pretty)}</div>
      <div class="agenda-sub">${escapeHtml(sub)}</div>
    </div>
    ${sections.map(s => `
      <div class="agenda-section">
        <div class="agenda-section-label">${s.label}</div>
        <div class="agenda-items">
          ${s.items.map(ev => {
            const ci = derive.colorIndex(ev.courseCode);
            return `
              <a class="agenda-item${ev.submitted ? ' is-done' : ''}${ev.closed ? ' is-closed' : ''}" href="${ev.href}" target="_blank" rel="noopener">
                <span class="agenda-item-icon chip-c${ci}">${ICONS[ev.icon] || ICONS.bell}</span>
                <div class="agenda-item-body">
                  <div class="agenda-item-title">${escapeHtml(ev.title)}</div>
                  <div class="agenda-item-meta">
                    <span class="chip chip-c${ci}">${escapeHtml(ev.courseCode)}</span>
                    ${ev.submitted ? '<span class="agenda-item-tag agenda-item-tag--done">Submitted ✓</span>' : ''}
                    ${ev.closed && !ev.submitted ? '<span class="agenda-item-tag agenda-item-tag--closed">Missed</span>' : ''}
                  </div>
                </div>
              </a>
            `;
          }).join('')}
        </div>
      </div>
    `).join('')}
  `;
}

function wireScheduleNav() {
  $('[data-schedule-prev]').addEventListener('click', () => {
    let y = state.scheduleYear, m = state.scheduleMonth - 1;
    if (m < 0) { m = 11; y -= 1; }
    state.scheduleYear = y; state.scheduleMonth = m;
    renderSchedule();
  });
  $('[data-schedule-next]').addEventListener('click', () => {
    let y = state.scheduleYear, m = state.scheduleMonth + 1;
    if (m > 11) { m = 0; y += 1; }
    state.scheduleYear = y; state.scheduleMonth = m;
    renderSchedule();
  });
  $('[data-schedule-today]').addEventListener('click', () => {
    const d = new Date();
    state.scheduleYear = d.getFullYear();
    state.scheduleMonth = d.getMonth();
    state.scheduleSelected = derive.dayKey(d);
    renderSchedule();
  });
}

/* Ensure OrgUnitId is a string everywhere (D2L mixes types). */
function stringIds(c) { return { ...c, OrgUnitId: String(c.OrgUnitId) }; }

const STATUS = {
  todo:   { label: 'Not yet started', cls: '',           icon: null },
  draft:  { label: 'Saved as draft',  cls: '',           icon: null },
  done:   { label: 'Submitted',       cls: 'pill--done', icon: 'check' },
  graded: { label: 'Graded',          cls: 'pill--done', icon: 'check' },
};

function renderUpNext(items) {
  const grid = $('#up-next-grid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty-card">Nothing due in the next 3 weeks. Breathe.</div>`;
    return;
  }
  grid.innerHTML = items.map((t, i) => {
    const ci = derive.colorIndex(t.courseCode);
    const urgent = i === 0 && daysUntil(t.due) <= 3 && t.status !== 'done';
    const st = STATUS[t.status] || STATUS.todo;
    const hasNote = !!(state.notes[t.id] && state.notes[t.id].trim());
    return `
      <a class="task-card${urgent ? ' task-card--urgent' : ''}${hasNote ? ' has-note' : ''}"
         href="${t.href}" target="_blank" rel="noopener"
         data-task-id="${escapeHtml(t.id)}"
         data-task-title="${escapeHtml(t.title)}">
        <button class="task-notes-btn" type="button" aria-label="Note" data-notes-toggle>
          ${ICONS.edit}
        </button>
        <div class="task-head">
          <span class="chip chip-c${ci}">${escapeHtml(t.courseCode)}</span>
          <span class="task-due">${escapeHtml(derive.dueLabel(t.due))}</span>
        </div>
        <div class="task-title-row">
          <span class="task-icon">${ICONS[t.icon] || ICONS.file}</span>
          <div>
            <div class="task-title">${escapeHtml(t.title)}</div>
            <div class="task-type">${escapeHtml(t.type)}</div>
          </div>
        </div>
        <div class="task-foot">
          <span class="pill ${st.cls}">${st.icon ? ICONS[st.icon] : ''}${st.label}</span>
        </div>
      </a>
    `;
  }).join('');

  // Wire notes buttons
  grid.querySelectorAll('[data-notes-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest('.task-card');
      openNotesPopover(card);
    });
  });
}

function renderCourses(arranged) {
  const grid = $('#course-grid');
  const items = [...arranged.pins, ...arranged.main];
  if (!items.length && !arranged.hidden.length) {
    grid.innerHTML = `<div class="empty-card">No active courses found. Are you logged into BigSky?</div>`;
    return;
  }

  let html = items.map(c => courseTile(c, arranged.pins.includes(c))).join('');

  if (arranged.hidden.length) {
    const expanded = state.hiddenExpanded;
    html += `
      <div class="hidden-section" data-expanded="${expanded}">
        <button class="hidden-section-toggle" type="button" data-toggle-hidden>
          <span>Other courses (${arranged.hidden.length})</span>
          <span class="hidden-section-chevron">${expanded ? '−' : '+'}</span>
        </button>
        <div class="hidden-section-body"${expanded ? '' : ' hidden'}>
          ${arranged.hidden.map(c => courseTile(c, false, { dimmed: true })).join('')}
        </div>
      </div>
    `;
  }

  grid.innerHTML = html;
  grid.querySelectorAll('.course-tile-photo').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
  });
  // Hidden toggle
  const toggle = grid.querySelector('[data-toggle-hidden]');
  if (toggle) toggle.addEventListener('click', () => {
    state.hiddenExpanded = !state.hiddenExpanded;
    render();
  });
  // Overflow buttons → open menu
  grid.querySelectorAll('[data-overflow]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCourseMenu(btn.dataset.overflow, btn);
    });
  });
  wireCoursePeek();
}

function courseTile(c, isPinned, opts = {}) {
  const code = derive.shortCode(c);
  const name = derive.displayName(c) || c.Name;
  const ci = derive.colorIndex(code);
  const customPhoto = state.photos[String(c.OrgUnitId)];
  const imgUrl = customPhoto || api.courseImageUrl(c.OrgUnitId);
  const preview = tilePreview(c);
  const highlights = tileHighlights(c);
  const cls = [
    'course-tile',
    isPinned ? 'course-tile--pinned' : '',
    opts.dimmed ? 'course-tile--dimmed' : '',
  ].filter(Boolean).join(' ');
  return `
    <a class="${cls}"
       href="https://bigsky.benilde.edu.ph/d2l/home/${c.OrgUnitId}"
       data-course-id="${c.OrgUnitId}"
       data-course-code="${escapeHtml(code)}"
       style="--course-bg: var(--c${ci}-bg); --course-fg: var(--c${ci}-fg);">
      <img class="course-tile-photo" src="${imgUrl}" alt="" loading="lazy">
      ${isPinned ? `<span class="course-tile-pin-badge" aria-label="Pinned">${ICONS.pin}</span>` : ''}
      <button class="course-tile-overflow" aria-label="Course options" data-overflow="${c.OrgUnitId}">${ICONS.more}</button>
      <div class="course-tile-body">
        <div class="course-tile-code">${escapeHtml(code)}</div>
        <div class="course-tile-name">${escapeHtml(name)}</div>
        <div class="course-tile-meta tone-${preview.tone}">${preview.label}</div>
        ${highlights.length ? `
          <div class="course-tile-highlights">
            ${highlights.map(h => `
              <div class="course-tile-highlight">
                <span class="course-tile-highlight-icon">${ICONS[h.icon]}</span>
                <span class="course-tile-highlight-title">${escapeHtml(h.title)}</span>
                <span class="course-tile-highlight-when">${escapeHtml(h.when)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </a>
  `;
}

/* Compose up to 2 highlight rows for a course tile.
 * 1. Next unsubmitted assignment due soon (next 21 days)
 * 2. Latest announcement posted in past 14 days */
function tileHighlights(c) {
  const b = state.bundles[c.OrgUnitId] || {};
  const submitted = new Set((b.submittedFolderIds || []).map(String));
  const out = [];
  const now = Date.now();
  const aDay = 86_400_000;

  /* Next due unsubmitted assignment within 21 days. Skip ones whose
   * submission window has already closed (Availability.EndDate in past). */
  const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
  const upcoming = folders
    .filter(f => f.DueDate && !submitted.has(String(f.Id)))
    .filter(f => {
      const endDate = f.Availability && f.Availability.EndDate;
      if (endDate && new Date(endDate).getTime() < now) return false;
      const t = new Date(f.DueDate).getTime();
      return t >= now - aDay && t <= now + 21 * aDay;
    })
    .sort((a, b) => new Date(a.DueDate) - new Date(b.DueDate));
  if (upcoming[0]) {
    out.push({
      icon: 'calendar',
      title: upcoming[0].Name,
      when: shortDue(upcoming[0].DueDate),
    });
  }

  /* Latest announcement in past 14 days. */
  const news = (b.news && !b.news.__error) ? b.news : [];
  const sorted = [...news].sort((a, b) =>
    new Date(b.LastModifiedDate || b.CreatedDate) - new Date(a.LastModifiedDate || a.CreatedDate)
  );
  const latest = sorted[0];
  if (latest) {
    const t = new Date(latest.LastModifiedDate || latest.CreatedDate).getTime();
    if (t > now - 14 * aDay) {
      out.push({
        icon: 'megaphone',
        title: latest.Title,
        when: derive.relativeTime(latest.LastModifiedDate || latest.CreatedDate),
      });
    }
  }
  return out;
}

/* Compact due label for tiles (less verbose than dueLabel used in Up Next). */
function shortDue(iso) {
  const t = new Date(iso).getTime();
  const days = Math.round((t - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* Compute the small "preview" line under the course name.
 * "2 due · 1 new" — actionable signal. "All caught up" when 0/0. */
function tilePreview(c) {
  const b = state.bundles[c.OrgUnitId] || {};
  const submitted = new Set((b.submittedFolderIds || []).map(String));

  // Unsubmitted assignments due in next 7 days, submission window still open
  const now = Date.now();
  const horizon = now + 7 * 86_400_000;
  const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
  let dueCount = 0;
  for (const f of folders) {
    if (!f.DueDate) continue;
    if (submitted.has(String(f.Id))) continue;
    const endDate = f.Availability && f.Availability.EndDate;
    if (endDate && new Date(endDate).getTime() < now) continue; // window closed
    const t = new Date(f.DueDate).getTime();
    if (t >= now && t <= horizon) dueCount++;
  }

  // Announcements posted in past 7 days
  const week = now - 7 * 86_400_000;
  const news = (b.news && !b.news.__error) ? b.news : [];
  let newCount = 0;
  for (const n of news) {
    const t = new Date(n.LastModifiedDate || n.CreatedDate).getTime();
    if (t >= week) newCount++;
  }

  if (dueCount === 0 && newCount === 0) {
    return { label: 'All caught up', tone: 'calm' };
  }
  const parts = [];
  if (dueCount > 0) parts.push(`${dueCount} ${dueCount === 1 ? 'due' : 'due'}`);
  if (newCount > 0) parts.push(`${newCount} new`);
  return { label: parts.join(' · '), tone: dueCount > 0 ? 'attention' : 'info' };
}

function renderFeed(items) {
  const list = $('#feed');
  if (!items.length) {
    list.innerHTML = `<li class="feed-empty">No new activity. You're caught up.</li>`;
    return;
  }
  list.innerHTML = items.map(it => {
    const ci = derive.colorIndex(it.courseCode);
    let body = '';
    if (it.kind === 'announcement') body = `New announcement in <strong>${escapeHtml(it.courseCode)}</strong> — ${escapeHtml(it.title)}`;
    else if (it.kind === 'grade')   body = `Grade posted: <strong>${escapeHtml(it.title)}</strong>`;
    else body = escapeHtml(it.title);
    const expandable = it.kind === 'announcement' && (it.bodyHtml || it.bodyText);
    return `
      <li class="feed-item${expandable ? ' is-expandable' : ''}" data-feed-id="${it.id}" data-kind="${it.kind}" data-course-id="${it.courseId}">
        <button class="feed-row" type="button">
          <span class="feed-dot chip-c${ci}">${ICONS[it.icon] || ICONS.bell}</span>
          <div class="feed-body">${body}</div>
          <span class="feed-time">${escapeHtml(derive.relativeTime(it.when))}</span>
        </button>
        ${expandable ? renderFeedExpanded(it) : ''}
      </li>
    `;
  }).join('');

  // Wire expand toggles
  list.querySelectorAll('.feed-item.is-expandable .feed-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const li = btn.closest('.feed-item');
      li.classList.toggle('is-expanded');
      const id = li.dataset.feedId;
      if (li.classList.contains('is-expanded')) store.markRead(id);
    });
  });
}

function renderFeedExpanded(it) {
  // Inline announcement body. Cookies are attached for any <img> in the HTML
  // because we're on the extension's origin with host_permissions.
  const safeBody = sanitizeAnnouncementHtml(it.bodyHtml || `<p>${escapeHtml(it.bodyText || '')}</p>`);
  const attach = (it.attachments && it.attachments.length)
    ? `<div class="feed-attachments">${it.attachments.map(a => `
        <a class="feed-attach" href="${escapeHtml(a.Href || '#')}" target="_blank" rel="noopener">
          <span class="feed-attach-icon">${ICONS.paperclip}</span>
          <span>${escapeHtml(a.FileName || a.Name || 'attachment')}</span>
        </a>`).join('')}</div>`
    : '';
  const openHref = `https://bigsky.benilde.edu.ph/d2l/lms/news/main.d2l?ou=${it.courseId}`;
  return `
    <div class="feed-expanded">
      <h3 class="feed-expanded-title">${escapeHtml(it.title)}</h3>
      <div class="feed-expanded-body">${safeBody}</div>
      ${attach}
      <div class="feed-expanded-foot">
        <a class="feed-expanded-link" href="${openHref}" target="_blank" rel="noopener">
          ${ICONS.externalLink} Open in BigSky
        </a>
      </div>
    </div>
  `;
}

/* Minimal sanitizer — strip script/style/iframe/object. D2L announcements
 * are author-controlled by instructors (whom you trust as students), so we
 * keep most HTML. Belt + suspenders: scrub the dangerous tags + event attrs. */
function sanitizeAnnouncementHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root.querySelectorAll('script, style, iframe, object, embed').forEach(n => n.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      if (attr.name === 'href' && /^javascript:/i.test(attr.value)) el.setAttribute('href', '#');
    }
  });
  return root.innerHTML;
}

/* ---- helpers ---- */

function daysUntil(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}


function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function showError(msg) {
  let el = $('#smallsky-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'smallsky-error';
    el.className = 'error-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
}
function hideError() { $('#smallsky-error')?.classList.remove('visible'); }

/* ---- theme (light/dark with circle-reveal animation) ---- */

function initTheme() {
  const saved = localStorage.getItem('smallsky-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const valid = saved === 'light' || saved === 'dark';
  document.documentElement.dataset.theme = valid ? saved : (prefersDark ? 'dark' : 'light');
}

async function toggleTheme(event) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem('smallsky-theme', next);
    refreshThemeIcon();
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduceMotion) { apply(); return; }

  const btn = $('[data-action="theme"]');
  const rect = btn.getBoundingClientRect();
  const x = (event && event.clientX) || (rect.left + rect.width / 2);
  const y = (event && event.clientY) || (rect.top + rect.height / 2);
  const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  const transition = document.startViewTransition(apply);
  await transition.ready;
  document.documentElement.animate(
    { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
    { duration: 650, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
  );
}

/* ---- settings popover ---- */

let settingsOpen = false;

async function toggleSettings(anchor) {
  if (settingsOpen) { closeSettings(); return; }
  closeProfileMenu();
  // Spin animation on the cog
  const cog = $('[data-action="settings"]');
  cog.classList.remove('cog-spinning');
  void cog.offsetWidth; // restart the animation
  cog.classList.add('cog-spinning');

  const auto = !!(state.prefs && state.prefs.autoReplaceHome);
  const lastSync = await store.cacheGet('lastSync');
  const lastSyncLabel = lastSync && lastSync.at
    ? `Synced ${derive.relativeTime(new Date(lastSync.at).toISOString())}`
    : 'Not synced yet';

  const pop = $('#settings-popover');
  pop.innerHTML = `
    <div class="settings-head">
      <h2 class="settings-title">Settings</h2>
      <button class="settings-close" aria-label="Close" data-settings-close>${ICONS.close}</button>
    </div>

    <section class="settings-section">
      <h3 class="settings-section-label">Behavior</h3>
      <label class="settings-toggle">
        <input type="checkbox" data-pref="autoReplaceHome" ${auto ? 'checked' : ''}>
        <span>
          <span class="settings-toggle-title">Auto-open SmallSky</span>
          <span class="settings-toggle-sub">Visiting BigSky home? Land here instead.</span>
        </span>
      </label>
    </section>

    <section class="settings-section">
      <h3 class="settings-section-label">Data</h3>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">${escapeHtml(lastSyncLabel)}</div>
          <div class="settings-row-sub">Background sync runs every 5 minutes.</div>
        </div>
        <button class="settings-action" data-settings-action="refresh">Refresh now</button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">Clear cache</div>
          <div class="settings-row-sub">Force fresh fetch of everything on next load.</div>
        </div>
        <button class="settings-action settings-action--danger" data-settings-action="clear">Clear</button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">Updates</div>
          <div class="settings-row-sub">SmallSky checks daily. Pull right now if you want.</div>
        </div>
        <button class="settings-action" data-settings-action="check-update">Check now</button>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section-label">About</h3>
      <div class="settings-about">
        <div class="settings-about-head">
          <img class="settings-about-icon" src="assets/icon-128.png" alt="">
          <div>
            <div class="settings-about-version">SmallSky v${escapeHtml(chrome.runtime.getManifest().version)}</div>
            ${(state.updateStatus && state.updateStatus.available && state.updateStatus.latest !== state.updateDismissed)
              ? `<button class="settings-about-update" data-update-action="show">v${escapeHtml(state.updateStatus.latest)} available →</button>`
              : ''}
          </div>
        </div>
        <div class="settings-about-tag">Made by Joaquin Bryan G. Ross</div>
        <div class="settings-about-subtag">Information Systems · ID 125</div>
        <div class="settings-about-links">
          <a class="settings-about-link settings-about-link--discord" href="https://discord.gg/DTvRR5qxxh" target="_blank" rel="noopener">
            ${ICONS.discord}
            <span>Join the support Discord</span>
          </a>
          <a class="settings-about-link settings-about-link--github" href="https://github.com/Nyrrine/smallsky" target="_blank" rel="noopener">
            ${ICONS.github}
            <span>See the code</span>
          </a>
        </div>
      </div>
      <details class="settings-changelog">
        <summary>What's new in v1.0.0</summary>
        <div class="settings-changelog-body">
          <ul>
            <li>Live BigSky data — courses, assignments, quizzes, grades, announcements pull straight from D2L's API with proper auth-session reuse.</li>
            <li><strong>Up Next</strong> — the four most urgent unsubmitted assignments and quizzes, sorted by due date, with real submission detection.</li>
            <li><strong>What's New</strong> — recent announcements with inline expand (no leaving the dashboard to read).</li>
            <li><strong>Month Schedule</strong> — calendar view of every dated event across all your courses, with day-by-day agenda.</li>
            <li><strong>Course tiles</strong> — color-coded pastels (stable per course code), real BigSky course photos, "next due" + "latest announcement" highlights, click-to-peek with weeks navigation.</li>
            <li><strong>Pin / hide / reorder</strong> — make the grid yours; admin courses move to a collapsed "Other" section.</li>
            <li><strong>Custom course photos</strong> — upload anything, auto-cropped to the BigSky banner aspect.</li>
            <li><strong>Local notes</strong> — pencil icon on every Up Next card, scratchpad per assignment, saved on this device only.</li>
            <li><strong>Cross-course search</strong> — press <kbd>/</kbd> to fuzzy-search announcements, modules, assignments, quizzes — all instant.</li>
            <li><strong>Light / dark theme</strong> — click the moon/sun for a smooth circle-reveal transition between themes.</li>
            <li><strong>Background sync + Chrome badge</strong> — service worker pings every 5 minutes, toolbar icon shows count of items due within 48 hours.</li>
            <li><strong>Auto-open SmallSky</strong> — optional redirect from BigSky's homepage to SmallSky, so you land here first thing.</li>
            <li><strong>Smart caching</strong> — tiered TTLs per resource (1 min for submission status, 24 h for whoami), stale-while-revalidate so first paint is always instant.</li>
            <li><strong>Daily update check</strong> — SmallSky pings GitHub once a day; a soft banner appears when a new version is out.</li>
            <li>Lots of soft touches — animated cog spin, cute logo shake, hover effects, friendly empty states.</li>
          </ul>
        </div>
      </details>
    </section>
  `;
  pop.hidden = false;
  positionSettings(pop, anchor);
  requestAnimationFrame(() => pop.classList.add('visible'));
  settingsOpen = true;
}

function closeSettings() {
  const pop = $('#settings-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!settingsOpen) pop.hidden = true; }, 160);
  settingsOpen = false;
}

function positionSettings(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const width = 360;
  pop.style.width = width + 'px';
  let left = r.right + window.scrollX - width;
  if (left < 12) left = 12;
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom + window.scrollY + 8) + 'px';
}

function wireGlobalSettingsHandlers() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen) closeSettings(); });
  document.addEventListener('click', (e) => {
    if (!settingsOpen) return;
    if (e.target.closest('#settings-popover')) return;
    if (e.target.closest('[data-action="settings"]')) return;
    closeSettings();
  });
  $('#settings-popover').addEventListener('click', async (e) => {
    if (e.target.closest('[data-settings-close]')) { closeSettings(); return; }
    if (e.target.closest('[data-update-action="show"]')) {
      closeSettings();
      openUpdateModal();
      return;
    }
    const action = e.target.closest('[data-settings-action]')?.dataset.settingsAction;
    if (action === 'refresh') {
      const btn = e.target.closest('button');
      btn.textContent = 'Refreshing…';
      btn.disabled = true;
      try { await store.cacheClear(); await refreshAll({ swr: false }); showToast('Refreshed.'); }
      catch (err) { showToast(`Refresh failed: ${err.message}`); }
      finally { closeSettings(); render(); }
    } else if (action === 'clear') {
      await store.cacheClear();
      showToast('Cache cleared. Reloading…');
      setTimeout(() => location.reload(), 600);
    } else if (action === 'check-update') {
      const btn = e.target.closest('button');
      btn.textContent = 'Checking…';
      btn.disabled = true;
      const result = await checkForUpdate();
      btn.textContent = 'Check now';
      btn.disabled = false;
      state.updateStatus = await getUpdateStatus();
      renderUpdateBanner();
      if (!result) {
        showToast('Couldn\'t reach GitHub. Try again later.');
      } else if (result.available) {
        closeSettings();
        showToast(`v${result.latest} is out — opening details…`);
        setTimeout(openUpdateModal, 300);
      } else {
        showToast(`You're on the latest version (v${result.current}).`);
      }
    }
  });
  $('#settings-popover').addEventListener('change', async (e) => {
    const pref = e.target.dataset.pref;
    if (pref === 'autoReplaceHome') {
      state.prefs = await store.setPrefs({ autoReplaceHome: e.target.checked });
      showToast(e.target.checked ? 'BigSky home will redirect to SmallSky now.' : 'Auto-redirect off.');
    }
  });
}

/* ---- bell popover (recent announcements) ---- */

let bellOpen = false;

function updateBellBadge() {
  const badge = $('#bell-badge');
  if (!badge) return;
  const items = recentAnnouncements();
  const unread = items.filter(i => !i._read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function recentAnnouncements() {
  const cutoff = Date.now() - 14 * 86_400_000;
  const out = [];
  for (const c of state.courses) {
    const b = state.bundles[c.OrgUnitId] || {};
    const news = (b.news && !b.news.__error) ? b.news : [];
    for (const n of news) {
      const t = new Date(n.LastModifiedDate || n.CreatedDate).getTime();
      if (t < cutoff) continue;
      out.push({
        id: `news:${c.OrgUnitId}:${n.Id}`,
        courseCode: derive.shortCode(c),
        courseId: c.OrgUnitId,
        title: n.Title,
        when: n.LastModifiedDate || n.CreatedDate,
        _read: !!(state._read && state._read[`news:${c.OrgUnitId}:${n.Id}`]),
      });
    }
  }
  out.sort((a, b) => new Date(b.when) - new Date(a.when));
  return out;
}

function toggleBell(anchor) {
  if (bellOpen) { closeBell(); return; }
  closeProfileMenu();
  closeSettings();
  const items = recentAnnouncements();
  const pop = $('#bell-popover');
  pop.innerHTML = `
    <div class="bell-head">
      <span class="bell-head-title">Notifications</span>
      ${items.length ? '<button class="bell-mark-all" data-bell-mark-all>Mark all read</button>' : ''}
    </div>
    <div class="bell-body">
      ${items.length === 0
        ? '<div class="bell-empty">No new notifications.</div>'
        : items.slice(0, 12).map(it => {
            const ci = derive.colorIndex(it.courseCode);
            return `
              <a class="bell-item${it._read ? ' is-read' : ''}" href="https://bigsky.benilde.edu.ph/d2l/lms/news/main.d2l?ou=${it.courseId}" target="_blank" rel="noopener">
                <span class="bell-item-icon chip-c${ci}">${ICONS.megaphone}</span>
                <div class="bell-item-body">
                  <div class="bell-item-title">${escapeHtml(it.title)}</div>
                  <div class="bell-item-meta">
                    <span class="chip chip-c${ci}">${escapeHtml(it.courseCode)}</span>
                    <span class="bell-item-when">${escapeHtml(derive.relativeTime(it.when))}</span>
                  </div>
                </div>
              </a>
            `;
          }).join('')}
    </div>
  `;
  pop.hidden = false;
  positionBell(pop, anchor);
  requestAnimationFrame(() => pop.classList.add('visible'));
  bellOpen = true;
}

function closeBell() {
  const pop = $('#bell-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!bellOpen) pop.hidden = true; }, 160);
  bellOpen = false;
}

function positionBell(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const width = 360;
  pop.style.width = width + 'px';
  let left = r.right + window.scrollX - width;
  if (left < 12) left = 12;
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
}

async function markAllAnnouncementsRead() {
  const items = recentAnnouncements();
  state._read = state._read || {};
  for (const it of items) {
    state._read[it.id] = Date.now();
    await store.markRead(it.id);
  }
  updateBellBadge();
  closeBell();
}

function wireGlobalBellHandlers() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bellOpen) closeBell(); });
  document.addEventListener('click', (e) => {
    if (!bellOpen) return;
    if (e.target.closest('#bell-popover')) return;
    if (e.target.closest('[data-action="bell"]')) return;
    closeBell();
  });
  $('#bell-popover').addEventListener('click', (e) => {
    if (e.target.closest('[data-bell-mark-all]')) {
      e.preventDefault();
      markAllAnnouncementsRead();
    }
  });
}

/* ---- profile dropdown menu ---- */

let profileMenuOpen = false;

function toggleProfileMenu(anchor) {
  if (profileMenuOpen) { closeProfileMenu(); return; }
  closeBell();
  const me = state.me || {};
  const fullName = [me.FirstName, me.LastName].filter(Boolean).join(' ') || 'You';
  const id = me.UniqueName || '';
  const initials = ((me.FirstName||'')[0] || '') + ((me.LastName||'')[0] || '');

  const menu = $('#profile-menu');
  menu.innerHTML = `
    <div class="profile-menu-head">
      <div class="profile-menu-avatar">${escapeHtml(initials.toUpperCase() || '·')}</div>
      <div class="profile-menu-id-block">
        <div class="profile-menu-name">${escapeHtml(fullName)}</div>
        ${id ? `<div class="profile-menu-id">${escapeHtml(id)}</div>` : ''}
      </div>
    </div>
    <div class="profile-menu-divider"></div>
    <a class="profile-menu-link" href="https://bigsky.benilde.edu.ph/d2l/lp/profile/profile_edit.d2l?ou=6606" target="_blank" rel="noopener">Profile</a>
    <div class="profile-menu-divider"></div>
    <a class="profile-menu-link profile-menu-link--danger" href="https://bigsky.benilde.edu.ph/d2l/logout">Log out of BigSky</a>
  `;
  menu.hidden = false;
  positionProfileMenu(menu, anchor);
  requestAnimationFrame(() => menu.classList.add('visible'));
  profileMenuOpen = true;
}

function closeProfileMenu() {
  const menu = $('#profile-menu');
  menu.classList.remove('visible');
  setTimeout(() => { if (!profileMenuOpen) menu.hidden = true; }, 160);
  profileMenuOpen = false;
}

function positionProfileMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const width = 280;
  menu.style.width = width + 'px';
  let left = r.right + window.scrollX - width;
  if (left < 12) left = 12;
  menu.style.left = left + 'px';
  menu.style.top = (r.bottom + window.scrollY + 6) + 'px';
}

/* ---- logged-out auth screen ---- */

function showLoggedOutScreen() {
  $('.page').style.display = 'none';
  $('#logged-out').hidden = false;

  /* Manual escape hatch — if SmallSky misjudged, click through to the dashboard
   * with whatever cached data we have. No auto-redirect — the user goes to
   * BigSky login only when they explicitly click the button. */
  $('#logged-out-override').addEventListener('click', async () => {
    $('#logged-out').hidden = true;
    $('.page').style.display = '';
    showToast('OK — showing cached data. Click refresh to retry the live fetch.');
    render();
  }, { once: true });
}

/* ---- assignment notes popover ---- */

const notesState = { openTaskId: null, anchor: null, debounceTimer: null };

function openNotesPopover(card) {
  hidePeek();
  closeCourseMenu();
  const taskId = card.dataset.taskId;
  const title = card.dataset.taskTitle;
  if (notesState.openTaskId === taskId) { closeNotesPopover(); return; }

  const pop = $('#notes-popover');
  const current = state.notes[taskId] || '';
  pop.innerHTML = `
    <div class="notes-head">
      <span class="notes-head-title">${escapeHtml(title)}</span>
      <button class="notes-close" aria-label="Close" data-notes-close>${ICONS.close}</button>
    </div>
    <textarea class="notes-textarea" placeholder="A quick note for yourself…">${escapeHtml(current)}</textarea>
    <div class="notes-foot muted">${current ? 'Saved automatically · just for you' : 'Saved automatically · just for you · local to this device'}</div>
  `;
  pop.dataset.taskId = taskId;
  pop.hidden = false;
  positionNotes(pop, card);
  requestAnimationFrame(() => {
    pop.classList.add('visible');
    pop.querySelector('textarea').focus();
  });
  notesState.openTaskId = taskId;
  notesState.anchor = card;

  // Wire input → debounced save
  const ta = pop.querySelector('textarea');
  ta.addEventListener('input', () => {
    clearTimeout(notesState.debounceTimer);
    notesState.debounceTimer = setTimeout(async () => {
      state.notes = await store.setNote(taskId, ta.value);
      // Update the card's has-note class so the dot indicator flips on/off
      const card = document.querySelector(`.task-card[data-task-id="${CSS.escape(taskId)}"]`);
      if (card) card.classList.toggle('has-note', !!ta.value.trim());
    }, 300);
  });
}

function closeNotesPopover() {
  const pop = $('#notes-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!notesState.openTaskId) pop.hidden = true; }, 160);
  notesState.openTaskId = null;
  notesState.anchor = null;
}

function positionNotes(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const width = Math.max(r.width, 280);
  pop.style.width = width + 'px';
  let left = r.left + window.scrollX;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  if (left < 12) left = 12;
  pop.style.left = left + 'px';
  pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
}

function wireGlobalNotesHandlers() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && notesState.openTaskId) closeNotesPopover(); });
  document.addEventListener('click', (e) => {
    if (!notesState.openTaskId) return;
    if (e.target.closest('#notes-popover')) return;
    if (e.target.closest('[data-notes-toggle]')) return;
    closeNotesPopover();
  });
  $('#notes-popover').addEventListener('click', (e) => {
    if (e.target.closest('[data-notes-close]')) { e.preventDefault(); closeNotesPopover(); }
  });
}

/* ---- course overflow menu (pin / hide / change photo) ---- */

const menuState = { openOuId: null };

function openCourseMenu(ouId, anchor) {
  hidePeek();
  if (menuState.openOuId === ouId) { closeCourseMenu(); return; }
  const isPinned = state.prefs.pinned.includes(ouId);
  const isHidden = state.prefs.hidden.includes(ouId);
  const hasCustom = !!state.photos[ouId];
  const menu = $('#course-menu');
  menu.innerHTML = `
    <button data-menu-action="pin">${ICONS.pin}<span>${isPinned ? 'Unpin' : 'Pin to top'}</span></button>
    <button data-menu-action="hide">${ICONS.hide}<span>${isHidden ? 'Show again' : 'Hide course'}</span></button>
    <div class="course-menu-divider"></div>
    <button data-menu-action="photo">${ICONS.file}<span>${hasCustom ? 'Change photo…' : 'Set custom photo…'}</span></button>
    ${hasCustom ? `<button data-menu-action="resetPhoto">${ICONS.close}<span>Reset photo</span></button>` : ''}
  `;
  menu.dataset.ouId = ouId;
  menu.hidden = false;
  positionMenu(menu, anchor);
  requestAnimationFrame(() => menu.classList.add('visible'));
  menuState.openOuId = ouId;
}

function closeCourseMenu() {
  const menu = $('#course-menu');
  menu.classList.remove('visible');
  setTimeout(() => { if (!menuState.openOuId) menu.hidden = true; }, 160);
  menuState.openOuId = null;
}

function positionMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const width = 200;
  menu.style.width = width + 'px';
  let left = r.right + window.scrollX - width;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  menu.style.left = left + 'px';
  menu.style.top = (r.bottom + window.scrollY + 6) + 'px';
}

function wireGlobalMenuHandlers() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuState.openOuId) closeCourseMenu(); });
  document.addEventListener('click', (e) => {
    if (!menuState.openOuId) return;
    if (e.target.closest('#course-menu')) return;
    if (e.target.closest('[data-overflow]')) return;
    closeCourseMenu();
  });
  $('#course-menu').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-menu-action]')?.dataset.menuAction;
    if (!action) return;
    const ouId = $('#course-menu').dataset.ouId;
    closeCourseMenu();
    if (action === 'pin')          { state.prefs = await store.togglePin(ouId); render(); }
    else if (action === 'hide')    { state.prefs = await store.toggleHidden(ouId); render(); }
    else if (action === 'photo')   { triggerPhotoUpload(ouId); }
    else if (action === 'resetPhoto') {
      state.photos = await store.setCoursePhoto(ouId, null);
      render();
      showToast('Photo reset to the BigSky default.');
    }
  });
}

/* ---- custom course photo upload ---- */

const photoState = { pendingOuId: null };

function triggerPhotoUpload(ouId) {
  photoState.pendingOuId = ouId;
  $('#photo-upload').value = '';   // allow re-selecting same file
  $('#photo-upload').click();
}

async function handlePhotoUpload(file) {
  const ouId = photoState.pendingOuId;
  photoState.pendingOuId = null;
  if (!ouId || !file) return;
  if (!/^image\//.test(file.type)) {
    showToast('That doesn\'t look like an image.');
    return;
  }
  showToast('Processing photo…');
  try {
    const dataUrl = await processCoursePhoto(file);
    state.photos = await store.setCoursePhoto(ouId, dataUrl);
    render();
    showToast('Photo updated.');
  } catch (e) {
    showToast(`Couldn't process that image: ${e.message}`);
  }
}

/* Crop to the same 64:27 (≈540×230) banner aspect as D2L's default course
 * images, then scale to 640×270 and encode as 85%-quality JPEG so storage
 * stays small (~30-60 KB per photo). */
async function processCoursePhoto(file, targetW = 640, targetH = 270) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image failed to decode'));
      i.src = url;
    });
    const targetRatio = targetW / targetH;
    const srcRatio = img.width / img.height;
    let sx, sy, sw, sh;
    if (srcRatio > targetRatio) {
      sh = img.height;
      sw = img.height * targetRatio;
      sx = (img.width - sw) / 2;
      sy = 0;
    } else {
      sw = img.width;
      sh = img.width / targetRatio;
      sx = 0;
      sy = (img.height - sh) / 2;
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function showToast(msg, ms = 2500) {
  const t = $('#smallsky-toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('visible'));
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => { t.hidden = true; }, 200);
  }, ms);
}

/* ---- course quick-peek popover (click-triggered) ---- */

const peekState = { openId: null, openTile: null };

function wireCoursePeek() {
  document.querySelectorAll('.course-tile').forEach(tile => {
    tile.addEventListener('click', (e) => {
      // Ctrl/Cmd/Shift click and middle-click → let the link open BigSky directly.
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      // Overflow button has its own handler — don't conflict.
      if (e.target.closest('[data-overflow]')) return;
      e.preventDefault();
      const courseId = tile.dataset.courseId;
      if (peekState.openId === courseId) hidePeek();
      else showPeek(tile);
    });
  });
}

/* Wire global close handlers ONCE on boot, not per-render. */
function wireGlobalPeekHandlers() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePeek(); });
  document.addEventListener('click', (e) => {
    if (!peekState.openId) return;
    if (e.target.closest('#course-peek')) return;
    if (e.target.closest('.course-tile')) return; // handled by tile click
    hidePeek();
  });
  // Close button inside the peek (delegated since the peek innerHTML re-renders).
  $('#course-peek').addEventListener('click', (e) => {
    if (e.target.closest('[data-peek-close]')) { e.preventDefault(); hidePeek(); }
  });
  // Only reposition on resize. Don't reposition on scroll — the peek is
  // position:absolute so it scrolls with the page naturally; recomputing on
  // every scroll event was clamping it to the top of the viewport when the
  // anchor tile scrolled out of view.
  window.addEventListener('resize', () => { if (peekState.openTile) positionPeek($('#course-peek'), peekState.openTile.getBoundingClientRect()); });
}

async function showPeek(tile) {
  closeCourseMenu();
  const courseId = tile.dataset.courseId;
  const code = tile.dataset.courseCode;
  if (!courseId) return;
  const peek = $('#course-peek');

  // Visually mark which tile is being peeked.
  document.querySelectorAll('.course-tile--peeking').forEach(t => t.classList.remove('course-tile--peeking'));
  tile.classList.add('course-tile--peeking');

  peekState.openId = courseId;
  peekState.openTile = tile;

  // Position: prefer below + same-left-edge. Flip up if no room.
  const r = tile.getBoundingClientRect();
  peek.hidden = false;
  peek.innerHTML = peekShell(code, courseId, 'loading');
  positionPeek(peek, r);
  peek.classList.add('visible');

  // Fire-and-forget: silently refresh this course's bundle in the background.
  // Keeps "due / new" counts on the tile + What's New current.
  loadCourseBundle(courseId, { swr: true })
    .then(b => { state.bundles[courseId] = b; render(); })
    .catch(() => {});

  // Fetch TOC + recent announcements (with cache).
  try {
    const toc = await getTOCCached(courseId);
    if (peekState.openId !== courseId) return; // user moved on
    const news = state.bundles[courseId]?.news || [];
    peek.innerHTML = peekShell(code, courseId, 'ready', { toc, news });
    positionPeek(peek, r);
  } catch (e) {
    if (peekState.openId !== courseId) return;
    peek.innerHTML = peekShell(code, courseId, 'error');
    positionPeek(peek, r);
  }
}

function hidePeek() {
  const peek = $('#course-peek');
  peek.classList.remove('visible');
  setTimeout(() => { if (!peek.classList.contains('visible')) { peek.hidden = true; } }, 180);
  document.querySelectorAll('.course-tile--peeking').forEach(t => t.classList.remove('course-tile--peeking'));
  peekState.openId = null;
  peekState.openTile = null;
}

function positionPeek(peek, tileRect) {
  // Pop up below tile by default. If too close to bottom of viewport, place above.
  const desiredWidth = 320;
  peek.style.width = desiredWidth + 'px';
  const margin = 8;
  let left = tileRect.left + window.scrollX;
  if (left + desiredWidth > window.innerWidth - 12) left = window.innerWidth - desiredWidth - 12;
  if (left < 12) left = 12;
  let top;
  const spaceBelow = window.innerHeight - tileRect.bottom;
  const spaceAbove = tileRect.top;
  const peekHeight = peek.offsetHeight || 320;
  if (spaceBelow > peekHeight + 20 || spaceBelow > spaceAbove) {
    top = tileRect.bottom + window.scrollY + margin;
  } else {
    top = tileRect.top + window.scrollY - peekHeight - margin;
  }
  peek.style.left = left + 'px';
  peek.style.top = Math.max(8, top) + 'px';
}

function peekShell(code, courseId, status, data) {
  let body = '';
  if (status === 'loading') {
    body = `<div class="peek-loading">Loading…</div>`;
  } else if (status === 'error') {
    body = `<div class="peek-error">Couldn’t load course details.</div>`;
  } else {
    body = `${peekTOC(data.toc, courseId)}${peekNews(data.news)}`;
  }
  return `
    <div class="peek-head">
      <span class="peek-code">${escapeHtml(code)}</span>
      <button class="peek-close" aria-label="Close" data-peek-close>${ICONS.close}</button>
    </div>
    <div class="peek-body">${body}</div>
    <div class="peek-foot">
      <a class="peek-link" href="https://bigsky.benilde.edu.ph/d2l/le/content/${courseId}/Home" target="_blank" rel="noopener">
        Open content ${ICONS.externalLink}
      </a>
    </div>
  `;
}

function peekTOC(toc, courseId) {
  const modules = (toc && toc.Modules) || [];
  if (!modules.length) {
    return `<div class="peek-section"><div class="peek-section-label">Modules</div><div class="peek-empty">No modules yet.</div></div>`;
  }
  const rows = modules.slice(0, 14).map(m => {
    const itemCount = (m.Modules?.length || 0) + (m.Topics?.length || 0);
    const href = `https://bigsky.benilde.edu.ph/d2l/le/content/${courseId}/Home?moduleId=${m.ModuleId || m.Id}`;
    return `
      <a class="peek-module" href="${href}" target="_blank" rel="noopener">
        <span class="peek-module-icon">${ICONS.module}</span>
        <span class="peek-module-title">${escapeHtml(m.Title)}</span>
        ${itemCount ? `<span class="peek-module-count">${itemCount}</span>` : ''}
      </a>
    `;
  }).join('');
  return `
    <div class="peek-section">
      <div class="peek-section-label">Weeks / Modules</div>
      <div class="peek-modules">${rows}</div>
    </div>
  `;
}

function peekNews(news) {
  const items = (news || []).slice(0, 3);
  if (!items.length) return '';
  return `
    <div class="peek-section">
      <div class="peek-section-label">Recent announcements</div>
      <ol class="peek-news">
        ${items.map(n => `
          <li class="peek-news-item">
            <span class="peek-news-title">${escapeHtml(n.Title)}</span>
            <span class="peek-news-time">${escapeHtml(derive.relativeTime(n.LastModifiedDate || n.CreatedDate))}</span>
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

async function getTOCCached(courseId) {
  const key = `toc:${courseId}`;
  const cached = await store.cacheGet(key);
  if (cached) return cached;
  const toc = await api.courseTOC(courseId);
  await store.cacheSet(key, toc, 30 * 60 * 1000); // 30 min
  return toc;
}

/* ---- update notifier (banner + modal) ---- */

function renderUpdateBanner() {
  const banner = $('#update-banner');
  const s = state.updateStatus;
  if (!s || !s.available || s.latest === state.updateDismissed) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <div class="update-banner-body">
      <span class="update-banner-mark">🌥️</span>
      <span class="update-banner-text">
        <strong>SmallSky v${escapeHtml(s.latest)}</strong> is available
        <span class="muted"> · you have v${escapeHtml(s.current)}</span>
      </span>
    </div>
    <div class="update-banner-actions">
      <button class="update-banner-btn update-banner-btn--primary" data-update-action="show">See what's new</button>
      <button class="update-banner-btn" data-update-action="dismiss" aria-label="Dismiss">${ICONS.close}</button>
    </div>
  `;
  banner.querySelector('[data-update-action="show"]').addEventListener('click', openUpdateModal);
  banner.querySelector('[data-update-action="dismiss"]').addEventListener('click', async () => {
    await dismissUpdate(s.latest);
    state.updateDismissed = s.latest;
    renderUpdateBanner();
    showToast(`Reminders for v${s.latest} dismissed.`);
  });
}

function openUpdateModal() {
  const s = state.updateStatus;
  if (!s || !s.available) return;
  const info = s.info || {};
  const changes = Array.isArray(info.changes) && info.changes.length ? info.changes : ['(no changelog provided)'];
  const released = info.released ? new Date(info.released + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const downloadUrl = info.downloadUrl || `https://github.com/Nyrrine/smallsky/archive/refs/heads/main.zip`;
  const discordUrl = info.discordUrl || 'https://discord.gg/DTvRR5qxxh';

  const modal = $('#update-modal');
  modal.innerHTML = `
    <div class="update-modal-card">
      <button class="update-modal-close" aria-label="Close" data-update-close>${ICONS.close}</button>
      <h2 class="update-modal-title">SmallSky v${escapeHtml(s.latest)} is out 🌥️</h2>
      ${released ? `<div class="update-modal-released">Released ${escapeHtml(released)} · you have v${escapeHtml(s.current)}</div>` : ''}
      <div class="update-modal-section">
        <h3>What's new</h3>
        <ul class="update-modal-changes">
          ${changes.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
        </ul>
      </div>
      <div class="update-modal-section">
        <h3>How to update (about 1 minute)</h3>
        <ol class="update-modal-steps">
          <li>
            <strong>Download the new version</strong>
            <a class="update-modal-action" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener">↓ Download v${escapeHtml(s.latest)}</a>
          </li>
          <li>
            <strong>Replace your <code>smallsky</code> folder</strong>
            <p class="muted">Unzip the new download and replace the folder you originally installed from.</p>
          </li>
          <li>
            <strong>Reload SmallSky</strong>
            <p class="muted">Open <code>chrome://extensions</code>, find SmallSky, click the ↻ reload icon. Then refresh this dashboard.</p>
          </li>
        </ol>
        <p class="muted update-modal-discord">
          Prefer a picture guide? <a href="${escapeHtml(discordUrl)}" target="_blank" rel="noopener">Join the Discord</a> — the install thread covers updates too.
        </p>
      </div>
      <div class="update-modal-foot">
        <button class="update-modal-btn" data-update-action="dismiss-modal">Remind me later</button>
      </div>
    </div>
  `;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('visible'));

  modal.querySelector('[data-update-close]').addEventListener('click', closeUpdateModal);
  modal.querySelector('[data-update-action="dismiss-modal"]').addEventListener('click', async () => {
    await dismissUpdate(s.latest);
    state.updateDismissed = s.latest;
    closeUpdateModal();
    renderUpdateBanner();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeUpdateModal();
  }, { once: true });
}

function closeUpdateModal() {
  const modal = $('#update-modal');
  modal.classList.remove('visible');
  setTimeout(() => { modal.hidden = true; }, 160);
}

/* ---- top-bar search (Google-style, persistent) ---- */

const searchState = { query: '', results: [], cursor: 0, debounceTimer: null };

function showResultsPanel() { $('#search-results').classList.add('visible'); }
function hideResultsPanel() { $('#search-results').classList.remove('visible'); }
function focusSearch() {
  const input = $('#search-input');
  input.focus();
  input.select();
}

function runSearch(query) {
  searchState.query = query;
  searchState.results = searchAll(query, { courses: state.courses, bundles: state.bundles });
  searchState.cursor = 0;
  renderSearchResults();
}

function renderSearchResults() {
  const wrap = $('#search-results');
  const q = (searchState.query || '').trim();
  if (q.length < 2) {
    hideResultsPanel();
    wrap.innerHTML = '';
    return;
  }
  if (!searchState.results.length) {
    showResultsPanel();
    wrap.innerHTML = `<div class="search-empty">No matches for <strong>${escapeHtml(q)}</strong>.</div>`;
    return;
  }
  showResultsPanel();
  wrap.innerHTML = searchState.results.map((r, i) => {
    const ci = derive.colorIndex(r.courseCode);
    const kindIcon = {
      announcement: ICONS.megaphone,
      assignment:   ICONS.file,
      quiz:         ICONS.quiz,
      module:       ICONS.module,
      course:       ICONS.book || ICONS.module,
    }[r.kind] || ICONS.bell;
    return `
      <a class="search-row${i === searchState.cursor ? ' is-active' : ''}" href="${r.href}" target="_blank" rel="noopener" data-idx="${i}">
        <span class="search-row-icon chip-c${ci}">${kindIcon}</span>
        <div class="search-row-body">
          <div class="search-row-title">${highlight(r.title, searchState.query)}</div>
          ${r.snippet ? `<div class="search-row-snippet">${r.snippet}</div>` : ''}
          <div class="search-row-meta">
            <span class="chip chip-c${ci}">${escapeHtml(r.courseCode)}</span>
            <span class="search-row-kind">${kindLabel(r.kind)}</span>
            ${r.when ? `<span class="search-row-when">${escapeHtml(derive.relativeTime(r.when))}</span>` : ''}
          </div>
        </div>
      </a>
    `;
  }).join('');
}

function highlight(text, q) {
  const t = escapeHtml(text || '');
  if (!q) return t;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})`, 'ig');
  return t.replace(re, '<mark>$1</mark>');
}

function kindLabel(k) {
  return { announcement: 'Announcement', assignment: 'Assignment', quiz: 'Quiz', module: 'Module / Week', course: 'Course' }[k] || k;
}

function moveSearchCursor(delta) {
  if (!searchState.results.length) return;
  const n = searchState.results.length;
  searchState.cursor = (searchState.cursor + delta + n) % n;
  renderSearchResults();
  // Scroll active row into view
  const active = $('#search-results .is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function activateSearchResult() {
  const r = searchState.results[searchState.cursor];
  if (!r) return;
  window.open(r.href, '_blank', 'noopener');
  $('#search-input').blur();
  hideResultsPanel();
}

function wireSearch() {
  const input = $('#search-input');

  input.addEventListener('input', () => {
    clearTimeout(searchState.debounceTimer);
    searchState.debounceTimer = setTimeout(() => runSearch(input.value), 80);
  });

  input.addEventListener('focus', () => {
    // Re-show results if there's already a query
    if (input.value.trim().length >= 2) {
      runSearch(input.value);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown')       { e.preventDefault(); moveSearchCursor(1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); moveSearchCursor(-1); }
    else if (e.key === 'Enter')      { e.preventDefault(); activateSearchResult(); }
    else if (e.key === 'Escape')     { e.preventDefault(); input.value = ''; runSearch(''); input.blur(); }
  });

  // Click outside the search wrap → hide results (but keep query in input)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.topbar-search-wrap')) return;
    hideResultsPanel();
  });

  $('#search-results').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.search-row');
    if (!row) return;
    const idx = +row.dataset.idx;
    if (idx !== searchState.cursor) { searchState.cursor = idx; renderSearchResults(); }
  });

  // Global '/' focuses the input (unless typing somewhere else)
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      focusSearch();
    }
  });
}

/* ---- events ---- */

function wireGlobalEvents() {
  wireGlobalPeekHandlers();
  wireGlobalMenuHandlers();
  wireGlobalNotesHandlers();
  wireGlobalBellHandlers();
  wireGlobalProfileHandlers();
  wireGlobalSettingsHandlers();
  wireScheduleNav();
  wireSearch();
  $('#photo-upload').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handlePhotoUpload(file);
  });
  $('[data-action="theme"]').addEventListener('click', toggleTheme);
  $('[data-action="bell"]').addEventListener('click', (e) => { e.preventDefault(); toggleBell(e.currentTarget); });
  $('[data-action="settings"]').addEventListener('click', (e) => { e.preventDefault(); toggleSettings(e.currentTarget); });
  $('[data-action="profile"]').addEventListener('click', (e) => { e.preventDefault(); toggleProfileMenu(e.currentTarget); });
  // Brand logo shake — cute touch on click
  const brand = document.querySelector('.brand-logo');
  if (brand) {
    brand.addEventListener('click', () => {
      brand.classList.remove('shaking');
      void brand.offsetWidth; // force reflow so animation restarts on repeat clicks
      brand.classList.add('shaking');
    });
  }
}

function wireGlobalProfileHandlers() {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && profileMenuOpen) closeProfileMenu(); });
  document.addEventListener('click', (e) => {
    if (!profileMenuOpen) return;
    if (e.target.closest('#profile-menu')) return;
    if (e.target.closest('[data-action="profile"]')) return;
    closeProfileMenu();
  });
}
