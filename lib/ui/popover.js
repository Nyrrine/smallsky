/* Shared popover primitives.
 *
 * Six popovers across the dashboard (settings, bell, profile, course menu,
 * peek, notes) had grown six near-identical position functions and six
 * near-identical Escape + outside-click handlers. These helpers cover both. */

/* Anchor an absolutely-positioned popover to a trigger element.
 *
 * Options:
 *   width      - fixed width in pixels (default 320)
 *   minWidth   - if set, the popover takes max(anchor.width, minWidth)
 *                — used by the notes popover to match the parent card width
 *   gap        - vertical space between anchor and popover (default 6)
 *   margin     - minimum viewport-edge padding (default 8)
 *   align      - 'right' aligns the popover's right edge with the anchor's
 *                right edge; 'left' aligns the left edges (default 'right')
 *   flip       - when true, place above the anchor if there's more room
 *                above than below (default false). Used by the course peek. */
export function positionAnchored(el, anchor, opts = {}) {
  const {
    width = 320,
    minWidth = null,
    gap = 6,
    margin = 8,
    align = 'right',
    flip = false,
  } = opts;

  const r = anchor.getBoundingClientRect();
  const w = minWidth !== null ? Math.max(r.width, minWidth) : width;
  el.style.width = w + 'px';

  let left = align === 'right'
    ? r.right + window.scrollX - w
    : r.left + window.scrollX;

  if (left + w > window.innerWidth - margin) left = window.innerWidth - w - margin;
  if (left < margin) left = margin;

  let top;
  if (flip) {
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const h = el.offsetHeight || 320;
    top = (spaceBelow > h + 20 || spaceBelow > spaceAbove)
      ? r.bottom + window.scrollY + gap
      : r.top + window.scrollY - h - gap;
    top = Math.max(margin, top);
  } else {
    top = r.bottom + window.scrollY + gap;
  }

  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

/* Wire Escape + outside-click dismiss for a popover.
 *
 * Pass the predicates rather than booleans so we capture the *current*
 * open state at click-time, not at wire-time.
 *
 * Options:
 *   isOpen          - () => boolean — is the popover open right now?
 *   close           - () => void — call to dismiss
 *   ignoreSelectors - clicks inside any element matching these selectors do
 *                     NOT close the popover. Include both the popover itself
 *                     and its trigger button (which has its own toggle). */
export function bindDismissable({ isOpen, close, ignoreSelectors = [] }) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    for (const sel of ignoreSelectors) {
      if (e.target.closest(sel)) return;
    }
    close();
  });
}
