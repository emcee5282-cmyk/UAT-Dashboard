// Field/type naming here intentionally mirrors the real leader-facing
// ticket schema (app/lib/db/schema.ts `tickets` table, and the create
// form's own field names in app/tickets/create/page.tsx) for consistency —
// this route is mock-data-only and does not read from or write to that
// schema. The settlement workflow itself (submitted/review/resolved/
// rejected, reject reasons, request-info) is a new concept scoped only to
// this prototype; the real system's ticket status model
// (pending/ongoing/settled) has no equivalent for it yet.

export type TicketType = 'agent_concern' | 'shop_replacement' | 'adding_new_account';

export type SettleStatus = 'submitted' | 'review' | 'resolved' | 'rejected';

export type Priority = 'low' | 'medium' | 'high';

// Derived, not stored — see getTag() in mockData.ts.
export type Tag = 'OPS' | 'ACC';

export type TicketFields =
  | { type: 'agent_concern'; issueType: string; agentIds: string[]; details: string }
  | { type: 'shop_replacement'; shop: string }
  | { type: 'adding_new_account'; dailyLimit: string; limitDuration: 'day_shift' | '24_hours'; numShops: number };

export type HistoryEntry = {
  status: SettleStatus;
  timestamp: string;
  actor: string;
  note?: string;
};

export type ChatMessage = {
  id: string;
  from: 'leader' | 'settler' | 'system';
  author?: string;
  text: string;
  imageDataUrl?: string;
  timestamp: string;
};

export type Ticket = {
  id: string;
  fields: TicketFields;
  leaderName: string;
  line: 1 | 2;
  priority: Priority;
  status: SettleStatus;
  submittedAt: string;
  internalNotes: string;
  history: HistoryEntry[];
  messages: ChatMessage[];
};
