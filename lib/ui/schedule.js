/* Month-view schedule (calendar grid + per-day agenda).
 *
 * Reads from state.courses + state.bundles and renders into #schedule-calendar
 * and #schedule-agenda. Owns state.scheduleYear/Month/Selected for navigation.
 *
 * Clicks on agenda items route to the drawer (assignments/quizzes) or
 * announcement modal — wired via the openAnnouncement callback at init. */

import * as derive from '../derive.js';
import { ICONS } from '../icons.js';
import { escapeHtml } from '../util.js';
import { openTaskDrawer, scheduleEventToTask } from './drawer.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;
let _openAnnouncement = null;

export function initSchedule({ state, onOpenAnnouncement }) {
  _state = state;
  _openAnnouncement = onOpenAnnouncement;
  wireNav();
}

export function renderSchedule() {
  const state = _state;
  const events = derive.buildSchedule(state.courses, state.bundles);
  const year = state.scheduleYear;
  const month = state.scheduleMonth;
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#schedule-month-label').textContent = monthLabel;

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

  grid.querySelectorAll('.cal-cell').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.day;
      const [y, m] = key.split('-').map(Number);
      state.scheduleSelected = key;
      // If user clicks a day in the prev/next month overflow, jump there.
      if (m - 1 !== state.scheduleMonth) {
        state.scheduleYear = y;
        state.scheduleMonth = m - 1;
      }
      renderSchedule();
    });
  });

  renderAgenda(events[state.scheduleSelected] || [], state.scheduleSelected);
}

function renderAgenda(events, dayStr) {
  const agenda = $('#schedule-agenda');
  const pretty = derive.prettyDay(dayStr);
  const sub = new Date(dayStr + 'T00:00:00').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });

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
              <a class="agenda-item${ev.submitted ? ' is-done' : ''}${ev.closed ? ' is-closed' : ''}"
                 href="${ev.href}" target="_blank" rel="noopener"
                 data-event-id="${escapeHtml(ev.id)}">
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

  // Intercept clicks: route to drawer (assignments/quizzes) or modal
  // (announcements). Ctrl/Cmd/Shift/middle-click still goes to BigSky directly.
  agenda.querySelectorAll('.agenda-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      const id = el.dataset.eventId;
      const ev = events.find(x => x.id === id);
      if (!ev) return;
      if (ev.kind === 'announcement') {
        const parts = ev.id.split(':');
        _openAnnouncement(parts[1], parts[2]);
      } else {
        openTaskDrawer(scheduleEventToTask(ev));
      }
    });
  });
}

function wireNav() {
  const state = _state;
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
