/* SmallSky cross-course search.
 *
 * Pure JS substring scan over cached data — no FTS engine, no WASM.
 * At student-scale (~1500 records) this runs in single-digit ms.
 *
 * Inputs: state.courses + state.bundles
 * Output: ranked array of result records.
 */

import { shortCode, displayName } from './derive.js';
import { BASE } from './api.js';
import { DAY_MS, escapeHtml } from './util.js';

/* Strip HTML for body text search. */
function plain(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Surround the first match with a <mark> tag and trim a snippet around it. */
function snippet(text, q, window = 60) {
  const lower = text.toLowerCase();
  const i = lower.indexOf(q);
  if (i < 0) return '';
  const start = Math.max(0, i - window);
  const end = Math.min(text.length, i + q.length + window);
  const before = (start > 0 ? '… ' : '') + escapeHtml(text.slice(start, i));
  const hit = `<mark>${escapeHtml(text.slice(i, i + q.length))}</mark>`;
  const after = escapeHtml(text.slice(i + q.length, end)) + (end < text.length ? ' …' : '');
  return before + hit + after;
}

/* Recency bonus — items in past 7 days get a small score boost. */
function recencyBoost(iso) {
  if (!iso) return 0;
  const days = (Date.now() - new Date(iso).getTime()) / DAY_MS;
  if (days < 0) return 0;
  if (days < 1) return 0.6;
  if (days < 7) return 0.4;
  if (days < 30) return 0.2;
  return 0;
}

/* Match title and body against query; return { score, snippet }. */
function scoreItem(query, title, body) {
  const q = query.toLowerCase();
  const t = (title || '').toLowerCase();
  const b = (body || '').toLowerCase();
  let score = 0;
  let snip = '';

  if (t.includes(q)) {
    score += 3;
    if (t.startsWith(q)) score += 1.5;   // prefix match bonus
    if (t === q) score += 2;             // exact match bonus
  }
  if (b.includes(q)) {
    score += 1;
    snip = snippet(body, q);
  }
  return { score, snip };
}

export function search(query, { courses, bundles }) {
  const q = (query || '').trim();
  if (q.length < 2) return [];

  const results = [];

  for (const c of courses || []) {
    const ouId = String(c.OrgUnitId);
    const b = bundles[ouId] || {};
    const code = shortCode(c);
    const courseName = displayName(c);

    /* Course itself — match if query is in code or name. */
    {
      const { score } = scoreItem(q, `${code} ${courseName}`, '');
      if (score > 0) {
        results.push({
          kind: 'course',
          courseCode: code,
          courseId: ouId,
          title: courseName,
          snippet: '',
          when: c.LastAccessed,
          href: `${BASE}/d2l/home/${ouId}`,
          score: score + 1, // tiny boost so course-name matches outrank content
        });
      }
    }

    /* Announcements — title + Body.Text. */
    const news = (b.news && !b.news.__error) ? b.news : [];
    for (const n of news) {
      const body = (n.Body && (n.Body.Text || plain(n.Body.Html))) || '';
      const { score, snip } = scoreItem(q, n.Title, body);
      if (score > 0) {
        const when = n.LastModifiedDate || n.CreatedDate;
        results.push({
          kind: 'announcement',
          courseCode: code,
          courseId: ouId,
          title: n.Title,
          snippet: snip,
          when,
          href: `${BASE}/d2l/lms/news/main.d2l?ou=${ouId}`,
          score: score + recencyBoost(when),
        });
      }
    }

    /* Dropbox assignments. */
    const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
    for (const f of folders) {
      const body = (f.CustomInstructions && (f.CustomInstructions.Text || plain(f.CustomInstructions.Html))) || '';
      const { score, snip } = scoreItem(q, f.Name, body);
      if (score > 0) {
        results.push({
          kind: 'assignment',
          courseCode: code,
          courseId: ouId,
          title: f.Name,
          snippet: snip,
          when: f.DueDate,
          href: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${f.Id}&ou=${ouId}`,
          score,
        });
      }
    }

    /* Quizzes. */
    const quizzes = (b.quizzes && !b.quizzes.__error && b.quizzes.Objects) || [];
    for (const qz of quizzes) {
      const body = (qz.Description && qz.Description.Text && (qz.Description.Text.Text || plain(qz.Description.Text.Html))) || '';
      const { score, snip } = scoreItem(q, qz.Name, body);
      if (score > 0) {
        results.push({
          kind: 'quiz',
          courseCode: code,
          courseId: ouId,
          title: qz.Name,
          snippet: snip,
          when: qz.DueDate || qz.EndDate,
          href: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qz.QuizId}&ou=${ouId}`,
          score,
        });
      }
    }

    /* Modules (TOC). Walks nested modules so subweeks are searchable too. */
    const toc = b.toc;
    if (toc && !toc.__error) walkModules(toc.Modules, (m, depth) => {
      const { score } = scoreItem(q, m.Title || '', '');
      if (score > 0) {
        results.push({
          kind: 'module',
          courseCode: code,
          courseId: ouId,
          title: m.Title,
          snippet: '',
          when: null,
          href: `${BASE}/d2l/le/content/${ouId}/Home?moduleId=${m.ModuleId || m.Id}`,
          score,
          depth,
        });
      }
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 40);
}

function walkModules(modules, visit, depth = 0) {
  if (!Array.isArray(modules)) return;
  for (const m of modules) {
    visit(m, depth);
    if (m.Modules) walkModules(m.Modules, visit, depth + 1);
  }
}
