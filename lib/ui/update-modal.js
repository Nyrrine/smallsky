/* Update notifier — banner across the top + a "what's new + how to update" modal.
 *
 * Pulls update status from state.updateStatus (loaded via lib/updater.js).
 * Dismissals are persisted via dismissUpdate so users can mute a specific
 * version after seeing it. */

import { ICONS } from '../icons.js';
import { escapeHtml } from '../util.js';
import { dismissUpdate } from '../updater.js';
import { showToast } from './toast.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;

export function initUpdateModal({ state }) {
  _state = state;
}

export function renderUpdateBanner() {
  const banner = $('#update-banner');
  const s = _state.updateStatus;
  if (!s || !s.available || s.latest === _state.updateDismissed) {
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
    _state.updateDismissed = s.latest;
    renderUpdateBanner();
    showToast(`Reminders for v${s.latest} dismissed.`);
  });
}

export function openUpdateModal() {
  const s = _state.updateStatus;
  if (!s || !s.available) return;
  const info = s.info || {};
  const changes = Array.isArray(info.changes) && info.changes.length ? info.changes : ['(no changelog provided)'];
  const released = info.released
    ? new Date(info.released + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const downloadUrl = info.downloadUrl || 'https://github.com/Nyrrine/smallsky/archive/refs/heads/main.zip';
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
    _state.updateDismissed = s.latest;
    closeUpdateModal();
    renderUpdateBanner();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeUpdateModal();
  }, { once: true });
}

export function closeUpdateModal() {
  const modal = $('#update-modal');
  modal.classList.remove('visible');
  setTimeout(() => { modal.hidden = true; }, 160);
}
