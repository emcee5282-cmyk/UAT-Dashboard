// Telegram Bot API client for "Send to TG" — one album per call. Pacing
// between albums (section 4.3's "~1 second apart") is the caller's job
// (the send orchestrator loops over jobs); this only handles one album's
// own request/retry/fallback.
export class TelegramInvalidTokenError extends Error {}

export type SendAlbumResult = { ok: true } | { ok: false; error: string };

async function postForm(url: string, form: FormData): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', body: form });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

// Telegram's sendMediaGroup rejects a 1-item array outright (it requires
// 2-10) — a leader+line with exactly one image falls back to sendPhoto,
// same precedent as the existing Dashboard "Send to Telegram" feature
// (app/api/telegram/screenshot/route.ts).
export async function sendAlbum(token: string, chatId: string, images: Buffer[], caption: string | undefined): Promise<SendAlbumResult> {
  if (images.length === 0) return { ok: false, error: 'No images to send.' };
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const form = new FormData();
    form.append('chat_id', chatId);
    let url: string;

    if (images.length === 1) {
      url = `https://api.telegram.org/bot${token}/sendPhoto`;
      if (caption) form.append('caption', caption);
      form.append('photo', new Blob([new Uint8Array(images[0])], { type: 'image/png' }), 'image.png');
    } else {
      url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
      const media = images.map((_, i) => ({ type: 'photo', media: `attach://photo${i}`, ...(i === 0 && caption ? { caption } : {}) }));
      form.append('media', JSON.stringify(media));
      images.forEach((buf, i) => form.append(`photo${i}`, new Blob([new Uint8Array(buf)], { type: 'image/png' }), `image${i}.png`));
    }

    const { ok, status, json } = await postForm(url, form);
    if (ok && json.ok) return { ok: true };

    if (status === 401) {
      throw new TelegramInvalidTokenError('TG Token is invalid — check Settings → Discrepancy TG');
    }

    if (status === 429) {
      const parameters = json.parameters as { retry_after?: number } | undefined;
      const retryAfter = parameters?.retry_after ?? 2;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
    }

    const description = typeof json.description === 'string' ? json.description : `Telegram API returned ${status}`;
    return { ok: false, error: description };
  }

  return { ok: false, error: 'Failed after retries.' };
}

// One PDF document per call — same retry/backoff/invalid-token handling as
// sendAlbum above, just a single sendDocument call instead of a media group.
export async function sendDocument(
  token: string,
  chatId: string,
  pdf: Buffer,
  filename: string,
  caption: string | undefined
): Promise<SendAlbumResult> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);

    const { ok, status, json } = await postForm(`https://api.telegram.org/bot${token}/sendDocument`, form);
    if (ok && json.ok) return { ok: true };

    if (status === 401) {
      throw new TelegramInvalidTokenError('TG Token is invalid — check Settings → Discrepancy TG');
    }

    if (status === 429) {
      const parameters = json.parameters as { retry_after?: number } | undefined;
      const retryAfter = parameters?.retry_after ?? 2;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
    }

    const description = typeof json.description === 'string' ? json.description : `Telegram API returned ${status}`;
    return { ok: false, error: description };
  }

  return { ok: false, error: 'Failed after retries.' };
}
