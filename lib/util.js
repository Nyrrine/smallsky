/* SmallSky shared utilities.
 *
 * Pure functions + constants used across modules. No DOM access beyond
 * DOMParser, no chrome.* calls. Safe to import from anywhere. */

/* Milliseconds in a day — used for date math throughout the codebase. */
export const DAY_MS = 86_400_000;

/* CSB's root org unit ID. Required as `ou=` parameter on a handful of D2L
 * pages (profile, logout-redirect) that are institution-scoped rather than
 * course-scoped. */
export const CSB_ROOT_OU = 6606;

/* HTML-escape a value for safe interpolation into innerHTML template strings.
 * Coerces to string and handles null/undefined → empty string. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

/* Format a byte count as a human-readable string.
 * Returns '' for null/undefined so it can be conditionally interpolated. */
export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/* Sanitize instructor-authored HTML (announcement body, assignment
 * instructions, grade comments) before injecting via innerHTML.
 *
 * Uses DOMParser rather than regex because regex-based HTML stripping is
 * famously fragile. We keep most tags — instructors use formatting, lists,
 * tables, links — but strip:
 *   - Scriptable elements (script, style, iframe, object, embed)
 *   - Event-handler attributes (onclick, onerror, ...)
 *   - javascript: URLs on hrefs (neutralized to '#') */
export function sanitizeAnnouncementHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root.querySelectorAll('script, style, iframe, object, embed').forEach(n => n.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      if (attr.name === 'href' && /^javascript:/i.test(attr.value)) {
        el.setAttribute('href', '#');
      }
    }
  });
  return root.innerHTML;
}
