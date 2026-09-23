// Rule-based priority classifier, run server-side at ticket creation
// (app/api/tickets POST) — never re-run, never LLM-based this pass. Matches
// case-insensitively against issueType + details combined; first matching
// tier wins (urgent beats moderate), 'normal' is the default when nothing
// matches (a ticket's priority is never left blank).
export type TicketPriority = 'urgent' | 'moderate' | 'normal';

const URGENT_KEYWORDS = ['block', 'frozen', 'unauthorized', 'balance clear', 'balance wiped', 'negative balance', 'hacked'];
const MODERATE_KEYWORDS = ['delay', 'mismatch', 'not updating', 'stuck', 'pending too long'];

export function classifyTicketPriority(issueType: string | null | undefined, details: string | null | undefined): TicketPriority {
  const text = `${issueType ?? ''} ${details ?? ''}`.toLowerCase();
  if (URGENT_KEYWORDS.some((kw) => text.includes(kw))) return 'urgent';
  if (MODERATE_KEYWORDS.some((kw) => text.includes(kw))) return 'moderate';
  return 'normal';
}
