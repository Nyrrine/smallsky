/* Injects a small launcher pill on every BigSky page + swaps the tab favicon
 * to the SmallSky cloud so BigSky-enhanced tabs visually unify with the
 * dashboard tab.
 *
 * Also: if the user has toggled "Auto-open SmallSky" in the profile menu and
 * lands on the BigSky home, redirect them to the dashboard before the BigSky
 * page even fully renders. */
(function () {
  /* Auto-redirect home → SmallSky if the pref is on. */
  try {
    chrome.storage.sync.get('prefs:v1', (data) => {
      const prefs = (data && data['prefs:v1']) || {};
      const p = location.pathname;
      const isHome = p === '/d2l/home' || p === '/d2l/home/';
      if (isHome && prefs.autoReplaceHome) {
        location.replace(chrome.runtime.getURL('dashboard.html'));
      }
    });
  } catch {}


  /* Replace BigSky's favicon with our cloud mark. */
  function setFavicon() {
    const href = chrome.runtime.getURL('assets/icon-32.png');
    // Remove existing favicon links so ours wins
    document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon']").forEach(l => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = href;
    (document.head || document.documentElement).appendChild(link);
  }

  function mountLauncher() {
    if (document.getElementById('smallsky-launcher')) return;
    if (!document.body) return;

    const btn = document.createElement('button');
    btn.id = 'smallsky-launcher';
    btn.type = 'button';
    btn.title = 'Open SmallSky';

    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('assets/icon-32.png');
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = 'SmallSky';
    btn.appendChild(img);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      window.open(chrome.runtime.getURL('dashboard.html'), '_blank');
    });
    document.body.appendChild(btn);
  }

  setFavicon();
  if (document.body) mountLauncher();
  else document.addEventListener('DOMContentLoaded', () => { setFavicon(); mountLauncher(); }, { once: true });
})();
