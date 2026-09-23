import type { ChatMessage, HistoryEntry, Tag, Ticket, TicketType } from './types';

export const TYPE_META: Record<TicketType, { label: string; dotVar: string }> = {
  agent_concern: { label: 'Agent concern', dotVar: '--accent' },
  shop_replacement: { label: 'Shop replacement', dotVar: '--amber' },
  adding_new_account: { label: 'Adding new account', dotVar: '--purple' },
};

export const STATUS_META: Record<Ticket['status'], { label: string; cls: string }> = {
  submitted: { label: 'Submitted', cls: 'statusSubmitted' },
  review: { label: 'In review', cls: 'statusReview' },
  resolved: { label: 'Resolved', cls: 'statusResolved' },
  rejected: { label: 'Rejected', cls: 'statusRejected' },
};

// Same preset list as the real create-ticket form (app/tickets/create/page.tsx)
export const ISSUE_TYPES = [
  'Reconnect wallet — OTP',
  'Ask agent to be put on WD only / DP only',
  'Clear balance',
  'Reduce balance',
  'Blocked account / locked',
  'House notice',
  'E-wallet office issue',
  'Suspend by e-wallet',
  'Agent problem',
  'Others',
];

export const LINE_LABEL: Record<1 | 2, string> = { 1: 'Line 1 · Cashout', 2: 'Line 2 · Send Money' };

// Tagging is computed from type, never stored — shop replacement and
// adding-new-account route to the Account Team, agent concerns to
// Operations.
export function getTag(t: Ticket): Tag {
  return t.fields.type === 'agent_concern' ? 'OPS' : 'ACC';
}

export const TAG_META: Record<Tag, { label: string; cls: string }> = {
  OPS: { label: 'Operations Team', cls: 'tagOps' },
  ACC: { label: 'Account Team', cls: 'tagAcc' },
};

function placeholderImage(bg: string, fg: string, label: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'><rect width='320' height='200' fill='${bg}'/><text x='16' y='30' font-family='Arial' font-size='14' fill='${fg}' font-weight='700'>${label}</text><rect x='16' y='50' width='288' height='16' fill='${fg}' opacity='0.25'/><rect x='16' y='74' width='220' height='16' fill='${fg}' opacity='0.25'/><rect x='16' y='98' width='250' height='16' fill='${fg}' opacity='0.25'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let msgSeq = 0;
function msg(partial: Omit<ChatMessage, 'id'>): ChatMessage {
  msgSeq += 1;
  return { id: `seed-${msgSeq}`, ...partial };
}

function history(entries: HistoryEntry[]): HistoryEntry[] {
  return entries;
}

export function buildInitialTickets(): Ticket[] {
  return [
    {
      id: 'TCK-1042',
      fields: { type: 'agent_concern', issueType: 'Blocked account / locked', agentIds: ['AGATA-2291'], details: 'Agent flagged after 3 failed OTP attempts this morning, shop still needs to run WD.' },
      leaderName: 'Rafiul Karim',
      line: 1,
      priority: 'high',
      status: 'resolved',
      submittedAt: '2026-09-08 09:12',
      internalNotes: '',
      history: history([
        { status: 'submitted', timestamp: '2026-09-08 09:12', actor: 'Rafiul Karim (leader)' },
        { status: 'resolved', timestamp: '2026-09-08 09:20', actor: 'Deepa Rahman (settler)' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Rafiul Karim', text: 'Hi, raising this for AGATA-2291 — blocked account or locked. Agent flagged after 3 failed OTP attempts this morning, shop still needs to run WD.', timestamp: '2026-09-08 09:12' }),
        msg({ from: 'leader', author: 'Rafiul Karim', text: "Here's the OTP error the agent is getting on their end.", imageDataUrl: placeholderImage('#1D2430', '#4E8BF0', 'OTP failed — attempt 3/3'), timestamp: '2026-09-08 09:14' }),
        msg({ from: 'system', text: 'Deepa Rahman marked this ticket as resolved.', timestamp: '2026-09-08 09:20' }),
      ],
    },
    {
      id: 'TCK-1041',
      fields: { type: 'shop_replacement', shop: 'SHOP-B2-0417 — Green Corner Store' },
      leaderName: 'Nusrat Jahan',
      line: 1,
      priority: 'medium',
      status: 'review',
      submittedAt: '2026-09-08 08:47',
      internalNotes: 'Checking replacement shop KYC before approving.',
      history: history([
        { status: 'submitted', timestamp: '2026-09-08 08:47', actor: 'Nusrat Jahan (leader)' },
        { status: 'review', timestamp: '2026-09-08 09:30', actor: 'Deepa Rahman (settler)', note: 'Pulled shop history for verification.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Nusrat Jahan', text: 'Requesting a shop swap for SHOP-B2-0417 — Green Corner Store.', timestamp: '2026-09-08 08:47' }),
        msg({ from: 'leader', author: 'Nusrat Jahan', text: 'Attaching a photo of the new shop front for the KYC check.', imageDataUrl: placeholderImage('#241E14', '#E0A93E', 'Green Corner Store — front'), timestamp: '2026-09-08 08:49' }),
        msg({ from: 'settler', author: 'Deepa Rahman', text: 'Pulled shop history for verification.', timestamp: '2026-09-08 09:30' }),
      ],
    },
    {
      id: 'TCK-1040',
      fields: { type: 'adding_new_account', dailyLimit: '৳150,000', limitDuration: '24_hours', numShops: 3 },
      leaderName: 'Farhan Ahmed',
      line: 2,
      priority: 'medium',
      status: 'submitted',
      submittedAt: '2026-09-08 08:20',
      internalNotes: '',
      history: history([{ status: 'submitted', timestamp: '2026-09-08 08:20', actor: 'Farhan Ahmed (leader)' }]),
      messages: [msg({ from: 'leader', author: 'Farhan Ahmed', text: 'Requesting 3 new shops on 24 hours, limit ৳150,000.', timestamp: '2026-09-08 08:20' })],
    },
    {
      id: 'TCK-1039',
      fields: { type: 'agent_concern', issueType: 'Reconnect wallet — OTP', agentIds: ['IPHONE-1187', 'IPHONE-1188'], details: '' },
      leaderName: 'Sadia Islam',
      line: 1,
      priority: 'low',
      status: 'resolved',
      submittedAt: '2026-09-07 17:05',
      internalNotes: 'Reconnected via provider portal, confirmed with leader over call.',
      history: history([
        { status: 'submitted', timestamp: '2026-09-07 17:05', actor: 'Sadia Islam (leader)' },
        { status: 'review', timestamp: '2026-09-07 17:22', actor: 'Deepa Rahman (settler)' },
        { status: 'resolved', timestamp: '2026-09-07 18:01', actor: 'Deepa Rahman (settler)', note: 'Reconnected via provider portal, confirmed with leader over call.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Sadia Islam', text: 'Hi, raising this for IPHONE-1187, IPHONE-1188 — reconnect wallet - OTP.', timestamp: '2026-09-07 17:05' }),
        msg({ from: 'settler', author: 'Deepa Rahman', text: 'Reconnected via provider portal, confirmed with leader over call.', timestamp: '2026-09-07 18:01' }),
        msg({ from: 'system', text: 'Deepa Rahman marked this ticket as resolved.', timestamp: '2026-09-07 18:01' }),
      ],
    },
    {
      id: 'TCK-1038',
      fields: { type: 'agent_concern', issueType: 'Reduce balance', agentIds: ['AGATA-0834'], details: 'Requested reduction of 40,000 pending reconciliation review.' },
      leaderName: 'Mahin Chowdhury',
      line: 2,
      priority: 'high',
      status: 'rejected',
      submittedAt: '2026-09-07 15:40',
      internalNotes: '',
      history: history([
        { status: 'submitted', timestamp: '2026-09-07 15:40', actor: 'Mahin Chowdhury (leader)' },
        { status: 'review', timestamp: '2026-09-07 16:02', actor: 'Deepa Rahman (settler)' },
        { status: 'rejected', timestamp: '2026-09-07 16:48', actor: 'Deepa Rahman (settler)', note: 'Reconciliation shows mismatch — needs finance sign-off first, please resubmit with recon reference.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Mahin Chowdhury', text: 'Hi, raising this for AGATA-0834 — reduce balance. Requested reduction of 40,000 pending reconciliation review.', timestamp: '2026-09-07 15:40' }),
        msg({ from: 'settler', author: 'Deepa Rahman', text: 'Reconciliation shows mismatch — needs finance sign-off first, please resubmit with recon reference.', timestamp: '2026-09-07 16:48' }),
        msg({ from: 'system', text: 'Ticket rejected.', timestamp: '2026-09-07 16:48' }),
      ],
    },
    {
      id: 'TCK-1037',
      fields: { type: 'shop_replacement', shop: 'SHOP-B1-1122 — Riverside Mart' },
      leaderName: 'Tania Akter',
      line: 1,
      priority: 'low',
      status: 'resolved',
      submittedAt: '2026-09-07 14:10',
      internalNotes: 'Old shop deactivated, new shop live on DP/WD.',
      history: history([
        { status: 'submitted', timestamp: '2026-09-07 14:10', actor: 'Tania Akter (leader)' },
        { status: 'review', timestamp: '2026-09-07 14:45', actor: 'Imran Hossain (settler)' },
        { status: 'resolved', timestamp: '2026-09-07 15:30', actor: 'Imran Hossain (settler)', note: 'Old shop deactivated, new shop live on DP/WD.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Tania Akter', text: 'Requesting a shop swap for SHOP-B1-1122 — Riverside Mart.', timestamp: '2026-09-07 14:10' }),
        msg({ from: 'settler', author: 'Imran Hossain', text: 'Old shop deactivated, new shop live on DP/WD.', timestamp: '2026-09-07 15:30' }),
        msg({ from: 'system', text: 'Imran Hossain marked this ticket as resolved.', timestamp: '2026-09-07 15:30' }),
      ],
    },
    {
      id: 'TCK-1036',
      fields: { type: 'adding_new_account', dailyLimit: '৳80,000', limitDuration: 'day_shift', numShops: 5 },
      leaderName: 'Rafiul Karim',
      line: 1,
      priority: 'medium',
      status: 'review',
      submittedAt: '2026-09-07 12:55',
      internalNotes: 'Confirming quota headroom before approving 5 new shops.',
      history: history([
        { status: 'submitted', timestamp: '2026-09-07 12:55', actor: 'Rafiul Karim (leader)' },
        { status: 'review', timestamp: '2026-09-07 13:20', actor: 'Imran Hossain (settler)', note: 'Confirming quota headroom before approving 5 new shops.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Rafiul Karim', text: 'Requesting 5 new shops on day shift, limit ৳80,000.', timestamp: '2026-09-07 12:55' }),
        msg({ from: 'settler', author: 'Imran Hossain', text: 'Confirming quota headroom before approving 5 new shops.', timestamp: '2026-09-07 13:20' }),
      ],
    },
    {
      id: 'TCK-1035',
      fields: { type: 'agent_concern', issueType: 'House notice', agentIds: ['AGATA-1900'], details: '' },
      leaderName: 'Nusrat Jahan',
      line: 1,
      priority: 'low',
      status: 'resolved',
      submittedAt: '2026-09-06 19:30',
      internalNotes: 'House notice acknowledged, agent briefed.',
      history: history([
        { status: 'submitted', timestamp: '2026-09-06 19:30', actor: 'Nusrat Jahan (leader)' },
        { status: 'review', timestamp: '2026-09-06 19:50', actor: 'Deepa Rahman (settler)' },
        { status: 'resolved', timestamp: '2026-09-06 20:15', actor: 'Deepa Rahman (settler)', note: 'House notice acknowledged, agent briefed.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Nusrat Jahan', text: 'Hi, raising this for AGATA-1900 — house notice.', timestamp: '2026-09-06 19:30' }),
        msg({ from: 'settler', author: 'Deepa Rahman', text: 'House notice acknowledged, agent briefed.', timestamp: '2026-09-06 20:15' }),
        msg({ from: 'system', text: 'Deepa Rahman marked this ticket as resolved.', timestamp: '2026-09-06 20:15' }),
      ],
    },
    {
      id: 'TCK-1034',
      fields: { type: 'agent_concern', issueType: 'Others', agentIds: ['AGATA-2600'], details: 'E-wallet provider is asking for updated trade license before reactivating — leader wants guidance on next steps.' },
      leaderName: 'Farhan Ahmed',
      line: 2,
      priority: 'high',
      status: 'submitted',
      submittedAt: '2026-09-06 18:02',
      internalNotes: '',
      history: history([{ status: 'submitted', timestamp: '2026-09-06 18:02', actor: 'Farhan Ahmed (leader)' }]),
      messages: [
        msg({ from: 'leader', author: 'Farhan Ahmed', text: 'Hi, raising this for AGATA-2600 — other issue. E-wallet provider is asking for updated trade license before reactivating — leader wants guidance on next steps.', timestamp: '2026-09-06 18:02' }),
      ],
    },
    {
      id: 'TCK-1033',
      fields: { type: 'shop_replacement', shop: 'SHOP-T1-0356 — Lakeview Traders' },
      leaderName: 'Sadia Islam',
      line: 1,
      priority: 'medium',
      status: 'rejected',
      submittedAt: '2026-09-06 16:15',
      internalNotes: '',
      history: history([
        { status: 'submitted', timestamp: '2026-09-06 16:15', actor: 'Sadia Islam (leader)' },
        { status: 'rejected', timestamp: '2026-09-06 16:40', actor: 'Imran Hossain (settler)', note: 'Duplicate request — shop already swapped under TCK-1029.' },
      ]),
      messages: [
        msg({ from: 'leader', author: 'Sadia Islam', text: 'Requesting a shop swap for SHOP-T1-0356 — Lakeview Traders.', timestamp: '2026-09-06 16:15' }),
        msg({ from: 'settler', author: 'Imran Hossain', text: 'Duplicate request — shop already swapped under TCK-1029.', timestamp: '2026-09-06 16:40' }),
        msg({ from: 'system', text: 'Ticket rejected.', timestamp: '2026-09-06 16:40' }),
      ],
    },
  ];
}
