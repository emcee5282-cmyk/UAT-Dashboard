// Profile photo prep, done in the browser before upload. The user picks the
// crop on the Profile modal's crop step (AvatarCropper); exportAvatarCrop
// then draws that square region onto a 640x640 canvas and exports WebP
// (quality 0.9) — or JPEG 0.92 where the browser can't encode WebP. The
// result is a data URL that PATCH /api/me/avatar stores as-is. 640px keeps
// the photo sharp on HiDPI screens at every size it's shown (max 96px CSS).
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp';
export const AVATAR_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const AVATAR_OUTPUT_SIZE = 640;
const WEBP_QUALITY = 0.9;
const JPEG_QUALITY = 0.92;
const ACCEPTED_TYPES = AVATAR_ACCEPT.split(',');

export class AvatarImageError extends Error {}

/** Square crop region in the source image's natural pixels. */
export type CropRect = { x: number; y: number; size: number };

/** Validates the file and decodes it. The caller revokes `url` when done. */
export async function loadAvatarSource(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new AvatarImageError('Choose a PNG, JPG or WebP image.');
  if (file.size > AVATAR_MAX_INPUT_BYTES) throw new AvatarImageError('Image is over 5MB. Choose a smaller one.');

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new AvatarImageError("That file couldn't be read as an image.");
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new AvatarImageError("That file couldn't be read as an image.");
  }
  return { img, url };
}

export function exportAvatarCrop(img: HTMLImageElement, crop: CropRect): string {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_OUTPUT_SIZE;
  canvas.height = AVATAR_OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AvatarImageError("Your browser couldn't process the image.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // White under transparent PNGs, so a JPEG fallback doesn't turn it black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);

  // Browsers without a WebP encoder silently return PNG — use JPEG then.
  const webp = canvas.toDataURL('image/webp', WEBP_QUALITY);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
