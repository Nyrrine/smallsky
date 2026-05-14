/* Cosmetic user avatar.
 *
 * Users can upload a photo for the topbar avatar + profile menu header.
 * Square crop, scaled to 256×256, JPEG-encoded at 0.85 quality, stored
 * locally as a dataURL. Doesn't sync to BigSky — purely a local skin.
 *
 * Render strategy: when an avatar is set, every spot showing the avatar
 * (topbar button + profile menu head) overlays an <img> on top of the
 * existing initials/dot text. CSS handles the visual swap so render code
 * doesn't need to know whether an avatar exists. */

import * as store from '../store.js';
import { showToast } from './toast.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;
let _render = null;

export function initAvatar({ state, render }) {
  _state = state;
  _render = render;
  $('#avatar-upload').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleUpload(file);
  });
}

export function triggerAvatarUpload() {
  $('#avatar-upload').value = ''; // allow re-selecting same file
  $('#avatar-upload').click();
}

export async function removeAvatar() {
  await store.setAvatar(null);
  _state.avatar = null;
  _render();
  showToast('Avatar reset to initials.');
}

async function handleUpload(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    showToast("That doesn't look like an image.");
    return;
  }
  showToast('Processing avatar…');
  try {
    const dataUrl = await processAvatar(file);
    _state.avatar = await store.setAvatar(dataUrl);
    _render();
    showToast('Avatar updated.');
  } catch (e) {
    showToast(`Couldn't process that image: ${e.message}`);
  }
}

/* Crop to a centered square, scale to 256×256, encode as 85%-quality JPEG.
 * 256 is small enough to keep storage under 30KB but sharp at all sizes
 * we render (topbar 36px, profile menu 40px — both well within 256). */
async function processAvatar(file, target = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image failed to decode'));
      i.src = url;
    });
    // Centered square crop of the source.
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
