// Classifies a raw fetch/API error message into a plain-language cause so
// users see something more useful than a generic "unable to load data."
// The API routes already pass through the real underlying error text (see
// app/lib/googleSheets.ts) — this just turns that raw text into a message a
// non-technical user can act on, while keeping the raw text available for
// anyone who needs to debug further.

export type ErrorKind = 'session' | 'auth' | 'network' | 'notfound' | 'unknown';

export type ClassifiedError = {
  kind: ErrorKind;
  title: string;
  message: string;
  detail: string;
};

// Detects OUR OWN app's session/role check (middleware.ts) by its EXACT
// JSON shape — { error: 'Unauthorized' } (no session) or { error:
// 'Forbidden' } (wrong role) — rather than loosely matching the word
// "unauthorized" anywhere in the text. Confirmed live: a page's own fetch
// to e.g. /api/dashboard after the login session expired returns this
// exact body, and the generic word-match below was mislabeling it
// "Google Sheets access lost" — a confusing, wrong diagnosis for what's
// actually just an expired login, unrelated to Sheets permissions at all.
function isOwnSessionError(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error === 'Unauthorized' || parsed?.error === 'Forbidden';
  } catch {
    return false;
  }
}

export function classifyFetchError(raw: string): ClassifiedError {
  if (isOwnSessionError(raw)) {
    return {
      kind: 'session',
      title: 'Session expired',
      message: 'Your login session has expired or is no longer valid. Please log in again to continue.',
      detail: raw,
    };
  }

  const lower = raw.toLowerCase();

  if (
    lower.includes('credentials') ||
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('invalid_grant')
  ) {
    return {
      kind: 'auth',
      title: 'Google Sheets access lost',
      message: 'The dashboard’s connection to Google Sheets was denied. This usually means the sheet’s sharing permissions changed, or the app’s access expired.',
      detail: raw,
    };
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return {
      kind: 'network',
      title: 'Cannot reach Google Sheets',
      message: 'The server could not connect to Google Sheets. This is usually temporary — check your internet connection or try again in a moment.',
      detail: raw,
    };
  }

  if (
    lower.includes('unable to parse range') ||
    lower.includes('not found') ||
    lower.includes('requested entity was not found')
  ) {
    return {
      kind: 'notfound',
      title: 'Sheet or tab not found',
      message: 'The sheet or tab this page reads from could not be found. It may have been renamed, moved, or deleted.',
      detail: raw,
    };
  }

  return {
    kind: 'unknown',
    title: 'Unable to load data',
    message: 'Something went wrong while loading data from Google Sheets.',
    detail: raw || 'No further detail was returned.',
  };
}

// Reads the failing response's real error text (instead of discarding it)
// and throws it so the catch block can classify what actually happened.
export async function assertAllOk(responses: Response[]): Promise<void> {
  for (const res of responses) {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Request failed with status ${res.status}`);
    }
  }
}
