/* Custom course-photo upload pipeline.
 *
 * User clicks "Change photo" in the course-tile overflow menu → triggers a
 * hidden <input type="file"> → image is cropped to the BigSky banner aspect,
 * scaled to 640×270, encoded as 85%-quality JPEG, and stored locally. */

import * as store from '../store.js';
import { showToast } from './toast.js';

const $ = (sel) => document.querySelector(sel);

const photoState = { pendingOuId: null };

let _state = null;
let _render = null;

export function initPhoto({ state, render }) {
  _state = state;
  _render = render;
  $('#photo-upload').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handlePhotoUpload(file);
  });
}

export function triggerPhotoUpload(ouId) {
  photoState.pendingOuId = ouId;
  $('#photo-upload').value = '';   // allow re-selecting the same file
  $('#photo-upload').click();
}

async function handlePhotoUpload(file) {
  const ouId = photoState.pendingOuId;
  photoState.pendingOuId = null;
  if (!ouId || !file) return;
  if (!/^image\//.test(file.type)) {
    showToast("That doesn't look like an image.");
    return;
  }
  showToast('Processing photo…');
  try {
    const dataUrl = await processCoursePhoto(file);
    _state.photos = await store.setCoursePhoto(ouId, dataUrl);
    _render();
    showToast('Photo updated.');
  } catch (e) {
    showToast(`Couldn't process that image: ${e.message}`);
  }
}

/* Crop to the same 64:27 (≈540×230) banner aspect as D2L's default course
 * images, then scale to 640×270 and encode as 85%-quality JPEG so storage
 * stays small (~30-60 KB per photo). */
async function processCoursePhoto(file, targetW = 640, targetH = 270) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image failed to decode'));
      i.src = url;
    });
    const targetRatio = targetW / targetH;
    const srcRatio = img.width / img.height;
    let sx, sy, sw, sh;
    if (srcRatio > targetRatio) {
      sh = img.height;
      sw = img.height * targetRatio;
      sx = (img.width - sw) / 2;
      sy = 0;
    } else {
      sw = img.width;
      sh = img.width / targetRatio;
      sx = 0;
      sy = (img.height - sh) / 2;
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
