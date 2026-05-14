/* Lightweight toast + error overlay.
 *
 * Both write to fixed DOM nodes that live in dashboard.html:
 *   #smallsky-toast — short-lived neutral message
 *   #smallsky-error — sticky red overlay (auto-created on first call) */

const $ = (sel) => document.querySelector(sel);

export function showToast(msg, ms = 2500) {
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

export function showError(msg) {
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
