/* Announcement detail modal.
 *
 * Opens when a course-tile peek, schedule agenda item, or feed item points to
 * a specific news entry. Reads from the cached bundle — no network on open. */

import * as api from '../api.js';
import * as derive from '../derive.js';
import * as store from '../store.js';
import { ICONS } from '../icons.js';
import { escapeHtml, formatBytes, sanitizeAnnouncementHtml } from '../util.js';
import { showToast } from './toast.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;

export function initAnnouncementModal({ state }) {
  _state = state;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#announcement-modal').hidden) closeAnnouncementModal();
  });
}

export function openAnnouncementModal(courseId, newsId) {
  const bundle = _state.bundles[String(courseId)] || {};
  const news = (bundle.news || []).find(n => String(n.Id) === String(newsId));
  if (!news) {
    showToast("Couldn't find that announcement — try refreshing.");
    return;
  }
  const course = _state.courses.find(c => String(c.OrgUnitId) === String(courseId));
  const courseCode = course ? derive.shortCode(course) : '';
  const ci = courseCode ? derive.colorIndex(courseCode) : 1;
  const when = derive.relativeTime(news.LastModifiedDate || news.CreatedDate);
  const bodyHtml = (news.Body && news.Body.Html) || `<p>${escapeHtml((news.Body && news.Body.Text) || '')}</p>`;
  const safeBody = sanitizeAnnouncementHtml(bodyHtml);
  const attachments = (news.Attachments || []).map(a => {
    // Valence pattern for news attachments. Cookie-authed, streams the file.
    const url = `${api.BASE}/d2l/api/le/1.93/${courseId}/news/${news.Id}/attachments/${a.FileId}`;
    const size = a.Size ? ` <span class="ann-attach-size">${formatBytes(a.Size)}</span>` : '';
    return `
      <a class="ann-attach" href="${escapeHtml(url)}" target="_blank" rel="noopener" download="${escapeHtml(a.FileName || 'file')}">
        ${ICONS.paperclip}
        <span>${escapeHtml(a.FileName || a.Name || 'attachment')}</span>
        ${size}
      </a>
    `;
  }).join('');

  const modal = $('#announcement-modal');
  modal.innerHTML = `
    <div class="announcement-modal-card">
      <button class="announcement-modal-close" aria-label="Close" data-ann-close>${ICONS.close}</button>
      <div class="announcement-modal-meta">
        <span class="chip chip-c${ci}">${escapeHtml(courseCode)}</span>
        <span class="announcement-modal-when">${escapeHtml(when)}</span>
      </div>
      <h2 class="announcement-modal-title">${escapeHtml(news.Title)}</h2>
      <div class="announcement-modal-body">${safeBody}</div>
      ${attachments ? `<div class="announcement-modal-attachments">${attachments}</div>` : ''}
      <div class="announcement-modal-foot">
        <a class="announcement-modal-link" href="${api.BASE}/d2l/lms/news/main.d2l?ou=${escapeHtml(String(courseId))}" target="_blank" rel="noopener">
          ${ICONS.externalLink} Open in BigSky
        </a>
      </div>
    </div>
  `;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('visible'));

  // Mark as read in our local store so the bell badge clears
  store.markRead(`news:${courseId}:${newsId}`).catch(() => {});

  modal.querySelector('[data-ann-close]').addEventListener('click', closeAnnouncementModal);
  modal.addEventListener('click', function bg(e) {
    if (e.target === modal) { closeAnnouncementModal(); modal.removeEventListener('click', bg); }
  });
}

export function closeAnnouncementModal() {
  const modal = $('#announcement-modal');
  modal.classList.remove('visible');
  setTimeout(() => { modal.hidden = true; }, 160);
}
