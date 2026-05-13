/* SmallSky update notifier.
 *
 * Polls a small version.json hosted on raw.githubusercontent.com once a day.
 * If the published version > the installed version, surfaces a non-blocking
 * banner on the dashboard. Chrome MV3 doesn't allow extensions to replace
 * their own files, so we can't auto-update — but we CAN make sure users
 * never miss an update and walk them through it. */

const REMOTE_VERSION_URL = 'https://raw.githubusercontent.com/Nyrrine/smallsky/main/version.json';
const STATUS_KEY  = 'update:status';
const DISMISSED_KEY = 'update:dismissed';

/* Numeric semver compare. Returns negative / 0 / positive. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* Fetch the latest manifest from GitHub, compute status, cache in storage. */
export async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  try {
    const res = await fetch(REMOTE_VERSION_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const status = {
      available: compareVersions(info.version, current) > 0,
      current,
      latest: info.version,
      info,
      lastChecked: Date.now(),
    };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
    return status;
  } catch (e) {
    console.warn('[smallsky] update check failed:', e.message);
    return null;
  }
}

export async function getUpdateStatus() {
  const v = await chrome.storage.local.get(STATUS_KEY);
  return v[STATUS_KEY] || null;
}

export async function getDismissedVersion() {
  const v = await chrome.storage.local.get(DISMISSED_KEY);
  return v[DISMISSED_KEY] || null;
}

export async function dismissUpdate(version) {
  await chrome.storage.local.set({ [DISMISSED_KEY]: version });
}
