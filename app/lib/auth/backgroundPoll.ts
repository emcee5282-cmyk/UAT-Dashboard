// Requests carrying this header (automatic polling, e.g. the ticket pages'
// chat refresh) don't count as user activity, so an open tab doesn't keep
// a session alive past the 2-hour idle timeout. Client-safe (no imports).
export const BACKGROUND_REQUEST_HEADER = 'x-background-poll';
export const BACKGROUND_POLL_HEADERS = { [BACKGROUND_REQUEST_HEADER]: '1' };
