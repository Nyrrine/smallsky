/* Inline task drawer.
 *
 * Renders the slide-in detail view for an Up Next item (assignment or quiz).
 * Pulls the full source object (folder/quiz) from the cached bundle to show
 * description, attachments, quiz extras, grade values, and a context-aware
 * footer CTA.
 *
 * Usage:
 *   import { initDrawer, openTaskDrawer, scheduleEventToTask } from './lib/ui/drawer.js';
 *   initDrawer({ state, store });
 *   openTaskDrawer(task);
 */

import * as api from '../api.js';
import * as derive from '../derive.js';
import { ICONS } from '../icons.js';
import { escapeHtml, formatBytes, sanitizeAnnouncementHtml } from '../util.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;
let _store = null;
let drawerTask = null; // the currently open task object

/* Wire the drawer once. Stashes shared refs and binds dismiss handlers. */
export function initDrawer({ state, store }) {
  _state = state;
  _store = store;
  wireGlobalHandlers();
}

/* Adapter: schedule event shape → drawer task shape. Lives here because the
 * drawer owns the canonical task shape. */
export function scheduleEventToTask(ev) {
  return {
    id: ev.id,
    kind: ev.kind === 'assignment' ? 'dropbox' : ev.kind,
    icon: ev.icon,
    courseCode: ev.courseCode,
    courseId: ev.courseId,
    title: ev.title,
    type: ev.kind === 'assignment' ? 'Assignment' : 'Quiz',
    due: ev.date,
    href: ev.href,
    status: ev.submitted ? 'done' : 'todo',
  };
}

/* Look up the GradeValue for an item by its GradeItemId.
 * `bundle.grades` is the cached /grades/values/myGradeValues/ response —
 * an array of GradeValue blocks whose GradeObjectIdentifier matches the
 * dropbox folder / quiz GradeItemId. */
function findGradeValue(bundle, gradeItemId) {
  if (!gradeItemId) return null;
  const grades = bundle.grades;
  if (!grades || grades.__error || !Array.isArray(grades)) return null;
  const target = String(gradeItemId);
  return grades.find(g => String(g.GradeObjectIdentifier) === target) || null;
}

/* Render the "Your grade" section if a grade is available. Handles the
 * common Numeric shape (PointsNumerator/PointsDenominator) and falls back
 * to DisplayedGrade for pass/fail / text grades. */
function gradeSectionHtml(grade) {
  if (!grade) return '';

  const num = typeof grade.PointsNumerator === 'number' ? grade.PointsNumerator : null;
  const den = typeof grade.PointsDenominator === 'number' ? grade.PointsDenominator : null;
  const hasPoints = num !== null && den !== null && den > 0;

  const displayed = (grade.DisplayedGrade || '').trim();
  if (!hasPoints && !displayed) return '';

  let scoreLine = '';
  if (hasPoints) {
    const pct = Math.round((num / den) * 100);
    const numStr = Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
    const denStr = Number.isInteger(den) ? String(den) : String(Math.round(den * 100) / 100);
    scoreLine = `
      <div class="drawer-grade-score">
        <span class="drawer-grade-points">${escapeHtml(numStr)}<span class="drawer-grade-denom"> / ${escapeHtml(denStr)}</span></span>
        <span class="drawer-grade-pct">${pct}%</span>
      </div>
    `;
  } else {
    scoreLine = `
      <div class="drawer-grade-score">
        <span class="drawer-grade-points">${escapeHtml(displayed)}</span>
      </div>
    `;
  }

  const released = grade.ReleasedDate || grade.LastModified;
  const releasedLine = released
    ? `<div class="drawer-grade-meta">Released ${escapeHtml(derive.relativeTime(released))}</div>`
    : '';

  const cHtml = grade.Comments && grade.Comments.Html;
  const cText = grade.Comments && grade.Comments.Text;
  let commentsBlock = '';
  if (cHtml || (cText && cText.trim())) {
    const raw = cHtml || `<p>${escapeHtml(cText)}</p>`;
    const safe = sanitizeAnnouncementHtml(raw);
    if (safe) {
      commentsBlock = `
        <div class="drawer-grade-comments">
          <div class="drawer-grade-comments-label">Instructor comment</div>
          <div class="drawer-prose">${safe}</div>
        </div>
      `;
    }
  }

  return `
    <section class="drawer-section drawer-grade-section">
      <h3>Your grade</h3>
      ${scoreLine}
      ${releasedLine}
      ${commentsBlock}
    </section>
  `;
}

/* Drawer status pill — slimmer than the global STATUS map; drawer always
 * shows a status pill, even for items that don't get one on the Up Next card. */
const STATUS_DRAWER = {
  todo:  { label: 'Not yet started', cls: '' },
  done:  { label: 'Submitted',       cls: 'pill--done' },
  draft: { label: 'In progress',     cls: '' },
};

export function openTaskDrawer(task) {
  if (!task) return;
  drawerTask = task;

  // Look up the full source object (folder or quiz) from cached bundles
  const bundle = _state.bundles[task.courseId] || {};
  let source = null;
  if (task.kind === 'dropbox') {
    source = (bundle.dropbox || []).find(f => String(f.Id) === String(task.id.split(':').pop()));
  } else if (task.kind === 'quiz') {
    source = ((bundle.quizzes && bundle.quizzes.Objects) || []).find(q => String(q.QuizId) === String(task.id.split(':').pop()));
  }

  const ci = derive.colorIndex(task.courseCode);
  const note = _state.notes[task.id] || '';
  const isQuiz = task.kind === 'quiz';

  // Description body (instructor-authored HTML — must be sanitized)
  let descHtml = '';
  if (source) {
    if (isQuiz) {
      const txt = source.Description && source.Description.Text;
      descHtml = (txt && (txt.Html || (txt.Text && `<p>${escapeHtml(txt.Text)}</p>`))) || '';
    } else {
      const ci2 = source.CustomInstructions;
      descHtml = (ci2 && (ci2.Html || (ci2.Text && `<p>${escapeHtml(ci2.Text)}</p>`))) || '';
    }
  }
  const safeDesc = descHtml ? sanitizeAnnouncementHtml(descHtml) : '';

  const attachments = source && source.Attachments ? source.Attachments : [];
  const linkAttachments = source && source.LinkAttachments ? source.LinkAttachments : [];

  // Your-grade section (joins dropbox/quiz GradeItemId → cached myGradeValues)
  const grade = findGradeValue(bundle, source && source.GradeItemId);
  const gradeHtml = gradeSectionHtml(grade);

  const st = STATUS_DRAWER[task.status] || STATUS_DRAWER.todo;

  // Quiz-specific meta row: AttemptsAllowed + live attempts summary + time limit + opens-on
  let quizExtras = '';
  if (isQuiz && source) {
    const allowed = source.AttemptsAllowed;
    const isUnlimited = !!(allowed && allowed.IsUnlimited);
    const maxAttempts = allowed ? (isUnlimited ? null : allowed.NumberOfAttemptsAllowed || 1) : null;

    const liveAttempts = (bundle.quizAttempts || {})[source.QuizId];
    let attemptsLabel;
    if (liveAttempts) {
      if (isUnlimited) {
        attemptsLabel = `${liveAttempts.count} taken (unlimited allowed)`;
      } else if (maxAttempts) {
        attemptsLabel = `${liveAttempts.count} of ${maxAttempts} taken`;
      }
    } else if (allowed) {
      attemptsLabel = isUnlimited ? 'Unlimited' : String(maxAttempts);
    }

    const scoreLabel = (liveAttempts && typeof liveAttempts.latestScore === 'number')
      ? `${liveAttempts.latestScore}`
      : null;

    const tl = source.SubmissionTimeLimit;
    const timeLimitLabel = tl && tl.IsEnforced && tl.TimeLimitValue
      ? `${tl.TimeLimitValue} min`
      : null;

    const rows = [
      attemptsLabel ? `<span><strong>Attempts:</strong> ${escapeHtml(attemptsLabel)}</span>` : '',
      scoreLabel ? `<span><strong>Latest score:</strong> ${escapeHtml(scoreLabel)}</span>` : '',
      timeLimitLabel ? `<span><strong>Time limit:</strong> ${escapeHtml(timeLimitLabel)}</span>` : '',
      source.StartDate ? `<span><strong>Opens:</strong> ${escapeHtml(derive.dueLabel(source.StartDate))}</span>` : '',
    ].filter(Boolean);
    if (rows.length) {
      quizExtras = `<div class="drawer-meta-row">${rows.join('')}</div>`;
    }
  }

  const drawer = $('#task-drawer');
  drawer.innerHTML = `
    <div class="drawer-head">
      <div class="drawer-meta">
        <span class="chip chip-c${ci}">${escapeHtml(task.courseCode)}</span>
        <span class="drawer-when">${escapeHtml(derive.dueLabel(task.due))}</span>
        <span class="pill ${st.cls}">${escapeHtml(st.label)}</span>
      </div>
      <button class="drawer-close" aria-label="Close" data-drawer-close>${ICONS.close}</button>
    </div>

    <div class="drawer-icon-row">
      <span class="drawer-icon">${ICONS[task.icon] || ICONS.file}</span>
      <div>
        <h2 class="drawer-title">${escapeHtml(task.title)}</h2>
        <div class="drawer-subtitle">${escapeHtml(task.type)}</div>
      </div>
    </div>

    ${quizExtras}

    ${safeDesc ? `
      <section class="drawer-section">
        <h3>${isQuiz ? 'Description' : 'Instructions'}</h3>
        <div class="drawer-prose">${safeDesc}</div>
      </section>
    ` : `
      <section class="drawer-section">
        <h3>${isQuiz ? 'Description' : 'Instructions'}</h3>
        <div class="drawer-empty">No description provided.</div>
      </section>
    `}

    ${attachments.length || linkAttachments.length ? `
      <section class="drawer-section">
        <h3>Attachments</h3>
        <div class="drawer-attachments">
          ${attachments.map(a => {
            // D2L Valence: GET this endpoint streams the file with the user's
            // session cookie. target=_blank + same-site request triggers a
            // download (or in-tab preview for browser-renderable types).
            const url = isQuiz
              ? `${api.BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${source.QuizId}&ou=${task.courseId}`
              : `${api.BASE}/d2l/api/le/1.93/${task.courseId}/dropbox/folders/${source.Id}/attachments/${a.FileId}`;
            const size = a.Size ? ` <span class="drawer-attach-size">${formatBytes(a.Size)}</span>` : '';
            return `
              <a class="drawer-attach" href="${escapeHtml(url)}" target="_blank" rel="noopener" download="${escapeHtml(a.FileName || 'file')}">
                ${ICONS.paperclip}
                <span class="drawer-attach-name">${escapeHtml(a.FileName || a.Name || 'attachment')}</span>
                ${size}
              </a>
            `;
          }).join('')}
          ${linkAttachments.map(a => `
            <a class="drawer-attach" href="${escapeHtml(a.Url || a.Href || '#')}" target="_blank" rel="noopener">
              ${ICONS.externalLink}
              <span class="drawer-attach-name">${escapeHtml(a.Name || a.Title || 'link')}</span>
            </a>
          `).join('')}
        </div>
      </section>
    ` : ''}

    ${gradeHtml}

    <section class="drawer-section">
      <h3>Your notes</h3>
      <textarea class="drawer-notes" placeholder="Quick reminders, breakdown of steps, links — just for you, never leaves this device.">${escapeHtml(note)}</textarea>
    </section>

    <div class="drawer-foot">
      ${drawerFootHtml(task, source, isQuiz)}
    </div>
  `;

  $('#task-drawer-backdrop').hidden = false;
  drawer.hidden = false;
  requestAnimationFrame(() => {
    $('#task-drawer-backdrop').classList.add('visible');
    drawer.classList.add('visible');
  });

  drawer.querySelector('[data-drawer-close]').addEventListener('click', closeTaskDrawer);

  // Wire notes auto-save (debounced)
  const ta = drawer.querySelector('.drawer-notes');
  let timer;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      _state.notes = await _store.setNote(task.id, ta.value);
      // Sync the card's has-note state on the underlying Up Next tile
      const card = document.querySelector(`.task-card[data-task-id="${CSS.escape(task.id)}"]`);
      if (card) card.classList.toggle('has-note', !!ta.value.trim());
    }, 300);
  });
}

/* Render the bottom of the drawer based on state.
 *   - Submitted → friendly "Submitted ✓" + link to submission history (no 403)
 *   - Closed (window passed, not submitted) → friendly "Dropbox closed :("
 *     to soften the 403 BigSky returns on these
 *   - Otherwise → normal Submit / Take quiz CTA */
function drawerFootHtml(task, source, isQuiz) {
  const submitted = task.status === 'done';
  const inProgress = task.status === 'draft';
  const endDate = source && source.Availability && source.Availability.EndDate;
  const closed = !isQuiz && !submitted && endDate && new Date(endDate).getTime() < Date.now();

  if (submitted && isQuiz) {
    // Quizzes don't have a "submission history" page — just point back to the quiz summary
    return `
      <div class="drawer-state-notice drawer-state-notice--done">
        <span class="drawer-state-icon">✓</span>
        <div class="drawer-state-body">
          <div class="drawer-state-title">Completed</div>
          <div class="drawer-state-sub">You've already taken this. Open on BigSky to review your attempt(s) or score.</div>
        </div>
      </div>
      <a class="drawer-cta drawer-cta--secondary" href="${escapeHtml(task.href)}" target="_blank" rel="noopener">
        Review on BigSky ${ICONS.externalLink}
      </a>
    `;
  }

  if (inProgress && isQuiz) {
    return `
      <div class="drawer-state-notice drawer-state-notice--inprogress">
        <span class="drawer-state-icon">⋯</span>
        <div class="drawer-state-body">
          <div class="drawer-state-title">In progress</div>
          <div class="drawer-state-sub">You started this quiz but haven't submitted yet. Open BigSky to resume.</div>
        </div>
      </div>
      <a class="drawer-cta" href="${escapeHtml(task.href)}" target="_blank" rel="noopener">
        Resume on BigSky ${ICONS.externalLink}
      </a>
    `;
  }

  if (submitted) {
    const historyUrl = source && source.Id
      ? `${api.BASE}/d2l/lms/dropbox/user/folders_history.d2l?db=${source.Id}&ou=${task.courseId}`
      : task.href;
    return `
      <div class="drawer-state-notice drawer-state-notice--done">
        <span class="drawer-state-icon">✓</span>
        <div class="drawer-state-body">
          <div class="drawer-state-title">Submitted</div>
          <div class="drawer-state-sub">You've turned this in. The window may have locked since, but your submission is on file.</div>
        </div>
      </div>
      <a class="drawer-cta drawer-cta--secondary" href="${escapeHtml(historyUrl)}" target="_blank" rel="noopener">
        View your submission ${ICONS.externalLink}
      </a>
    `;
  }

  if (closed) {
    const endedAgo = endDate ? ` ${derive.relativeTime(endDate)}` : '';
    return `
      <div class="drawer-state-notice drawer-state-notice--closed">
        <span class="drawer-state-icon">:(</span>
        <div class="drawer-state-body">
          <div class="drawer-state-title">Dropbox closed${endedAgo}</div>
          <div class="drawer-state-sub">The submission window has passed. BigSky won't accept new files for this one — opening the link will land on its 403 page.</div>
        </div>
      </div>
      <a class="drawer-cta drawer-cta--secondary" href="${escapeHtml(task.href)}" target="_blank" rel="noopener">
        Open on BigSky anyway ${ICONS.externalLink}
      </a>
    `;
  }

  return `
    <a class="drawer-cta" href="${escapeHtml(task.href)}" target="_blank" rel="noopener">
      ${isQuiz ? 'Take quiz on BigSky' : 'Submit on BigSky'} ${ICONS.externalLink}
    </a>
  `;
}

function closeTaskDrawer() {
  const drawer = $('#task-drawer');
  const bd = $('#task-drawer-backdrop');
  drawer.classList.remove('visible');
  bd.classList.remove('visible');
  setTimeout(() => {
    drawer.hidden = true;
    bd.hidden = true;
    drawerTask = null;
  }, 220);
}

/* Backdrop click + Escape close. Bound once during init. */
function wireGlobalHandlers() {
  $('#task-drawer-backdrop').addEventListener('click', closeTaskDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerTask) closeTaskDrawer();
  });
}
