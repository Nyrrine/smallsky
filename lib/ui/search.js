/* Cross-course search UI (top-bar Google-style).
 *
 * The actual ranking engine lives in lib/search.js. This module owns the
 * input wiring, the result panel, keyboard nav, and the `/` global hotkey. */

import * as derive from '../derive.js';
import { ICONS } from '../icons.js';
import { escapeHtml } from '../util.js';
import { search as searchAll } from '../search.js';

const $ = (sel) => document.querySelector(sel);

const searchState = { query: '', results: [], cursor: 0, debounceTimer: null };

let _state = null;

export function initSearch({ state }) {
  _state = state;
  wireSearch();
}

function showResultsPanel() { $('#search-results').classList.add('visible'); }
function hideResultsPanel() { $('#search-results').classList.remove('visible'); }
function focusSearch() {
  const input = $('#search-input');
  input.focus();
  input.select();
}

function runSearch(query) {
  searchState.query = query;
  searchState.results = searchAll(query, { courses: _state.courses, bundles: _state.bundles });
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
      course:       ICONS.module,
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
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return t.replace(re, '<mark>$1</mark>');
}

function kindLabel(k) {
  return {
    announcement: 'Announcement',
    assignment:   'Assignment',
    quiz:         'Quiz',
    module:       'Module / Week',
    course:       'Course',
  }[k] || k;
}

function moveSearchCursor(delta) {
  if (!searchState.results.length) return;
  const n = searchState.results.length;
  searchState.cursor = (searchState.cursor + delta + n) % n;
  renderSearchResults();
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
    if (input.value.trim().length >= 2) runSearch(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown')   { e.preventDefault(); moveSearchCursor(1); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); moveSearchCursor(-1); }
    else if (e.key === 'Enter')  { e.preventDefault(); activateSearchResult(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; runSearch(''); input.blur(); }
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
