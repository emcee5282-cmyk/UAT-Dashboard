'use client';

// Ports create_ticket_mobile.html's exact behavior into a real, leader-
// scoped page: cascading title selection (no fields until a title is
// picked), conditional field groups per title, agent-ID / shop search
// against the leader's real roster (app/api/agents/search), and the
// EN/বাংলা toggle — chrome-only, per the mockup's own trailing comment:
// ticket type names, dropdown option text, agent IDs, and shop names never
// translate, so data stays consistent across the system regardless of
// language. Now on the dashboard's shared design tokens (app/globals.css)
// instead of a hardcoded palette, same as /tickets and /tickets/[id].
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CheckCircle2, ChevronDown, Headphones, Info, List, Loader2, Store, UserPlus, X } from 'lucide-react';

type TitleKey = 'agent_concern' | 'shop_replacement' | 'adding_new_account';
type Lang = 'en' | 'bn';
type AgentOption = { id: number; agentCode: string };

const ISSUE_TYPES = [
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

const DURATIONS: { value: 'day_shift' | '24_hours'; label: string }[] = [
  { value: 'day_shift', label: 'Day shift' },
  { value: '24_hours', label: '24 hours' },
];

// Chrome-only translations — never applied to ticket type names, dropdown
// option text, agent IDs, or shop names (see file header).
const translations: Record<Lang, Record<string, string>> = {
  en: {
    topCancel: 'Cancel', topTitle: 'New ticket',
    step1: 'Title',
    titleSelectPlaceholder: 'Select ticket type',
    titleSelectHelper: "Choose the type of ticket you're raising.",
    step2Issue: 'Issue type', selectIssueType: 'Select issue type', describeIssue: 'Describe the issue',
    step3Agent: 'Select agent ID(s)', single: 'Single', multiple: 'Multiple',
    searchAgent: 'Search agent ID (e.g. AGATA, IPHONE)',
    agentHint: 'Type a prefix like "AGATA" or "IPHONE" to see matching IDs.',
    step4Details: 'Additional details (optional)', detailsPh: 'Provide any additional information that may help our team.',
    step2Shop: 'Select shops to replace', searchShop: 'Search and select shops',
    shopHint: 'Select the shop(s) that need to be replaced.',
    noteNewAccount: 'No shop selection required for adding new accounts. Just fill in the number of shops, daily limit, and duration.',
    step2Daily: 'Daily limit', dailyPh: 'Enter daily limit amount',
    step3Duration: 'Limit duration', selectDuration: 'Select duration',
    step4HowMany: 'How many shops', howManyPh: 'Enter number of shops',
    howManyHint: 'Total number of shops for this request.',
    noteLeader: "Shops you can view and select are based on your leader's configuration.",
    cancelBtn: 'Cancel', submitBtn: 'Submit ticket',
  },
  bn: {
    topCancel: 'বাতিল', topTitle: 'নতুন টিকেট',
    step1: 'শিরোনাম',
    titleSelectPlaceholder: 'টিকেট ধরন নির্বাচন করুন',
    titleSelectHelper: 'আপনি যে ধরনের টিকেট তুলছেন তা বেছে নিন',
    step2Issue: 'সমস্যার ধরন', selectIssueType: 'সমস্যার ধরন নির্বাচন করুন', describeIssue: 'সমস্যাটি বর্ণনা করুন',
    step3Agent: 'এজেন্ট আইডি নির্বাচন করুন', single: 'একক', multiple: 'একাধিক',
    searchAgent: 'এজেন্ট আইডি খুঁজুন (যেমন AGATA, IPHONE)',
    agentHint: '"AGATA" বা "IPHONE" এর মতো প্রিফিক্স লিখুন মিলে যাওয়া আইডি দেখতে।',
    step4Details: 'অতিরিক্ত বিবরণ (ঐচ্ছিক)', detailsPh: 'আমাদের দলকে সাহায্য করতে পারে এমন কোনো অতিরিক্ত তথ্য দিন।',
    step2Shop: 'প্রতিস্থাপনের জন্য শপ নির্বাচন করুন', searchShop: 'শপ খুঁজুন এবং নির্বাচন করুন',
    shopHint: 'যে শপগুলো প্রতিস্থাপন করা প্রয়োজন সেগুলো নির্বাচন করুন।',
    noteNewAccount: 'নতুন অ্যাকাউন্ট যোগ করতে শপ নির্বাচনের প্রয়োজন নেই। শুধু শপের সংখ্যা, দৈনিক সীমা এবং সময়কাল পূরণ করুন।',
    step2Daily: 'দৈনিক সীমা', dailyPh: 'দৈনিক সীমার পরিমাণ লিখুন',
    step3Duration: 'সীমার সময়কাল', selectDuration: 'সময়কাল নির্বাচন করুন',
    step4HowMany: 'কতগুলো শপ', howManyPh: 'শপের সংখ্যা লিখুন',
    howManyHint: 'এই অনুরোধের জন্য মোট শপের সংখ্যা।',
    noteLeader: 'আপনি যেসব শপ দেখতে ও নির্বাচন করতে পারবেন তা আপনার লিডারের কনফিগারেশনের উপর নির্ভরশীল।',
    cancelBtn: 'বাতিল', submitBtn: 'টিকেট জমা দিন',
  },
};

// One distinct color per ticket type, dark-mode aware — same technique as
// the leader list/detail pages' token conversion (semantic Tailwind scale
// + dark: variants instead of hardcoded hex).
const TYPE_CARDS: { key: TitleKey; icon: typeof Headphones; iconClass: string; title: string; desc: string }[] = [
  {
    key: 'agent_concern',
    icon: Headphones,
    iconClass: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400',
    title: 'Agent concern',
    desc: 'Report concerns or issues related to agents, wallets, or accounts.',
  },
  {
    key: 'shop_replacement',
    icon: Store,
    iconClass: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
    title: 'Shop replacement',
    desc: 'Replace existing shop(s) with new shop(s).',
  },
  {
    key: 'adding_new_account',
    icon: UserPlus,
    iconClass: 'bg-teal-50 text-teal-600 dark:bg-teal-500/10 dark:text-teal-400',
    title: 'Adding new account',
    desc: 'Add new shop account(s) to the system.',
  },
];

export default function CreateTicketPage() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('en');
  const t = translations[lang];

  const [selectedTitle, setSelectedTitle] = useState<TitleKey | null>(null);
  const [titleDropdownOpen, setTitleDropdownOpen] = useState(false);
  const selectedTypeCard = TYPE_CARDS.find((c) => c.key === selectedTitle) ?? null;

  // Agent concern
  const [issueType, setIssueType] = useState('');
  const [othersText, setOthersText] = useState('');
  const [agentMode, setAgentMode] = useState<'single' | 'multi'>('single');
  const [agentSearch, setAgentSearch] = useState('');
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<AgentOption[]>([]);
  const [agentDetails, setAgentDetails] = useState('');

  // Shop replacement
  const [shopSearch, setShopSearch] = useState('');
  const [shopDropdownOpen, setShopDropdownOpen] = useState(false);
  const [selectedShops, setSelectedShops] = useState<AgentOption[]>([]);

  // Adding new account
  const [dailyLimit, setDailyLimit] = useState('');
  const [limitDuration, setLimitDuration] = useState<'' | 'day_shift' | '24_hours'>('');
  const [numShops, setNumShops] = useState('');

  // Leader's roster — fetched once, filtered client-side per keystroke,
  // mirroring the mockup's own in-memory agentPool/shopPool arrays.
  const [roster, setRoster] = useState<AgentOption[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents/search')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load roster');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setRoster(data.agents ?? []);
      })
      .catch(() => {
        if (!cancelled) setRosterError('Could not load your agent/shop roster. Try refreshing the page.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agentMatches = useMemo(() => {
    const q = agentSearch.trim().toUpperCase();
    if (!q || !roster) return [];
    return roster.filter((a) => a.agentCode.includes(q));
  }, [agentSearch, roster]);

  const shopMatches = useMemo(() => {
    const q = shopSearch.trim().toLowerCase();
    if (!q || !roster) return [];
    const selectedIds = new Set(selectedShops.map((s) => s.id));
    return roster.filter((a) => a.agentCode.toLowerCase().includes(q) && !selectedIds.has(a.id));
  }, [shopSearch, roster, selectedShops]);

  function toggleAgent(option: AgentOption) {
    const exists = selectedAgents.some((a) => a.id === option.id);
    if (agentMode === 'single') {
      setSelectedAgents(exists ? [] : [option]);
      setAgentDropdownOpen(false);
      setAgentSearch('');
    } else {
      setSelectedAgents(exists ? selectedAgents.filter((a) => a.id !== option.id) : [...selectedAgents, option]);
      // Multi mode keeps the dropdown open and re-filters, matching the
      // mockup re-dispatching its own input event after each toggle.
    }
  }

  function setMode(mode: 'single' | 'multi') {
    setAgentMode(mode);
    if (mode === 'single' && selectedAgents.length > 1) setSelectedAgents([selectedAgents[0]]);
  }

  function selectShop(option: AgentOption) {
    setSelectedShops([...selectedShops, option]);
    setShopSearch('');
    setShopDropdownOpen(false);
  }

  const isReady = useMemo(() => {
    if (!selectedTitle) return false;
    if (selectedTitle === 'agent_concern') {
      const issueOk = issueType && (issueType !== 'Others' || othersText.trim().length > 0);
      return Boolean(issueOk) && selectedAgents.length > 0;
    }
    if (selectedTitle === 'shop_replacement') {
      return selectedShops.length > 0;
    }
    // adding_new_account
    const limitOk = dailyLimit.trim() !== '' && !Number.isNaN(Number(dailyLimit));
    const shopsOk = numShops.trim() !== '' && Number.isInteger(Number(numShops)) && Number(numShops) > 0;
    return limitOk && Boolean(limitDuration) && shopsOk;
  }, [selectedTitle, issueType, othersText, selectedAgents, selectedShops, dailyLimit, limitDuration, numShops]);

  async function handleSubmit() {
    if (!isReady || submittingRef.current || !selectedTitle) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    const body: Record<string, unknown> = { title: selectedTitle };
    if (selectedTitle === 'agent_concern') {
      body.issueType = issueType === 'Others' ? othersText.trim() : issueType;
      body.agentIds = selectedAgents.map((a) => a.id);
      body.details = agentDetails;
    } else if (selectedTitle === 'shop_replacement') {
      body.shopIds = selectedShops.map((s) => s.id);
    } else {
      body.dailyLimit = dailyLimit;
      body.limitDuration = limitDuration;
      body.numShops = numShops;
    }

    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(data.error || 'Something went wrong submitting the ticket.');
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      setSubmitSuccess(true);
      submittingRef.current = false;
      setSubmitting(false);
    } catch {
      setSubmitError('Something went wrong. Please try again.');
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (submitSuccess) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background px-6 font-[Inter,sans-serif]">
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-2xl border border-border bg-card p-8 text-center shadow-[0_10px_40px_rgba(20,20,50,0.06)]">
          <CheckCircle2 size={40} className="mb-4 text-emerald-600 dark:text-emerald-400" />
          <h2 className="text-[17px] font-bold text-foreground">Ticket submitted</h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">Your ticket has been created and sent to the team.</p>
          <button
            type="button"
            onClick={() => router.push('/tickets')}
            className="mt-6 w-full rounded-[10px] bg-[color:var(--ui-accent)] px-4 py-3 text-[14px] font-bold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] focus-visible:ring-offset-2"
          >
            Back to my tickets
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full justify-center bg-background font-[Inter,sans-serif] text-foreground">
      <div className="flex w-full max-w-[480px] flex-col bg-background">
        {/* Topbar — Cancel / New ticket / EN·বাংলা, no submit action here (see
            the bottom bar's Submit ticket button, the only submit trigger). */}
        <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-[18px] pb-3 pt-3.5">
          <button
            type="button"
            onClick={() => router.push('/tickets')}
            className="shrink-0 rounded-md text-[14px] font-semibold text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
          >
            {t.topCancel}
          </button>
          <span className="truncate text-[15px] font-bold">{t.topTitle}</span>
          <div className="inline-flex shrink-0 rounded-[7px] border border-border p-0.5">
            <button
              type="button"
              onClick={() => setLang('en')}
              aria-pressed={lang === 'en'}
              className={`rounded-[5px] px-2.5 py-1 text-[11px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                lang === 'en' ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'text-muted-foreground'
              }`}
            >
              EN
            </button>
            <button
              type="button"
              onClick={() => setLang('bn')}
              aria-pressed={lang === 'bn'}
              className={`rounded-[5px] px-2.5 py-1 text-[11px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                lang === 'bn' ? 'bg-[color:var(--ui-accent-soft)] text-[color:var(--ui-accent)]' : 'text-muted-foreground'
              }`}
            >
              বাংলা
            </button>
          </div>
        </div>

        {/* Scrollable form */}
        <div className="flex-1 px-4 pb-6 pt-[18px]">
          {rosterError && (
            <div className="mb-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
              {rosterError}
            </div>
          )}

          {/* Title selection — collapsible dropdown-as-cards, nothing
              pre-selected on first load; tapping the closed trigger opens
              the panel, picking a card collapses it back. */}
          <div className="mb-[22px]">
            <div className="mb-2.5 text-[12.5px] font-bold">
              {t.step1} <span className="text-rose-600 dark:text-rose-400">*</span>
            </div>
            <button
              type="button"
              onClick={() => setTitleDropdownOpen((v) => !v)}
              aria-expanded={titleDropdownOpen}
              aria-label={selectedTypeCard && !titleDropdownOpen ? undefined : t.titleSelectPlaceholder}
              className="flex w-full items-center gap-3 rounded-xl border-[1.5px] border-border bg-card p-3.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
            >
              {selectedTypeCard && !titleDropdownOpen ? (
                <>
                  <span className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg ${selectedTypeCard.iconClass}`}>
                    <selectedTypeCard.icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="mb-0.5 block text-[13.5px] font-bold text-foreground">{selectedTypeCard.title}</span>
                    <span className="block text-[11.5px] leading-[1.4] text-muted-foreground">{selectedTypeCard.desc}</span>
                  </span>
                </>
              ) : (
                <>
                  <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <List size={16} />
                  </span>
                  <span className="min-w-0 flex-1 text-[13.5px] font-medium text-muted-foreground">{t.titleSelectPlaceholder}</span>
                </>
              )}
              <ChevronDown size={16} className={`shrink-0 text-muted-foreground transition-transform ${titleDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {titleDropdownOpen && (
              <div className="mt-2.5 flex flex-col gap-2.5">
                {TYPE_CARDS.map(({ key, icon: Icon, iconClass, title, desc }) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => {
                      setSelectedTitle(key);
                      setTitleDropdownOpen(false);
                    }}
                    className="flex items-start gap-3 rounded-xl border-[1.5px] border-border bg-card p-3.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
                  >
                    <span className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg ${iconClass}`}>
                      <Icon size={16} />
                    </span>
                    <span>
                      <span className="mb-0.5 block text-[13.5px] font-bold text-foreground">{title}</span>
                      <span className="block text-[11.5px] leading-[1.4] text-muted-foreground">{desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!selectedTypeCard && !titleDropdownOpen && (
              <div className="mt-1.5 text-[11.5px] text-muted-foreground">{t.titleSelectHelper}</div>
            )}
          </div>

          {selectedTitle === 'agent_concern' && (
            <>
              <div className="mb-[22px]">
                <div className="mb-2.5 text-[12.5px] font-bold">
                  {t.step2Issue} <span className="text-rose-600 dark:text-rose-400">*</span>
                </div>
                <select
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value)}
                  className="w-full rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                >
                  <option value="">{t.selectIssueType}</option>
                  {ISSUE_TYPES.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                {issueType === 'Others' && (
                  <textarea
                    value={othersText}
                    onChange={(e) => setOthersText(e.target.value)}
                    placeholder={t.describeIssue}
                    className="mt-2.5 min-h-[80px] w-full resize-none rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                  />
                )}
              </div>

              <div className="mb-[22px]">
                <div className="mb-2.5 text-[12.5px] font-bold">
                  {t.step3Agent} <span className="text-rose-600 dark:text-rose-400">*</span>
                </div>
                <div className="mb-2.5 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('single')}
                    aria-pressed={agentMode === 'single'}
                    className={`rounded-[8px] border px-3 py-2 text-[13px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                      agentMode === 'single' ? 'border-transparent bg-[color:var(--ui-accent)] text-white' : 'border-border bg-card text-foreground'
                    }`}
                  >
                    {t.single}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('multi')}
                    aria-pressed={agentMode === 'multi'}
                    className={`rounded-[8px] border px-3 py-2 text-[13px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] ${
                      agentMode === 'multi' ? 'border-transparent bg-[color:var(--ui-accent)] text-white' : 'border-border bg-card text-foreground'
                    }`}
                  >
                    {t.multiple}
                  </button>
                </div>
                {selectedAgents.length > 0 && (
                  <div className="mb-2.5 flex flex-wrap gap-1.5">
                    {selectedAgents.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center gap-1.5 rounded-[7px] bg-[color:var(--ui-accent-soft)] px-2.5 py-1.5 text-[12px] font-semibold text-[color:var(--ui-accent)]"
                      >
                        {a.agentCode}
                        <button
                          type="button"
                          onClick={() => setSelectedAgents(selectedAgents.filter((s) => s.id !== a.id))}
                          aria-label={`Remove ${a.agentCode}`}
                          className="rounded font-extrabold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <input
                    type="text"
                    value={agentSearch}
                    onChange={(e) => {
                      setAgentSearch(e.target.value);
                      setAgentDropdownOpen(e.target.value.trim().length > 0);
                    }}
                    placeholder={t.searchAgent}
                    className="w-full rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] font-normal text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                  />
                  {agentDropdownOpen && agentMatches.length > 0 && (
                    <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-[180px] overflow-y-auto rounded-[9px] border border-border bg-card shadow-lg">
                      {agentMatches.map((a) => {
                        const checked = selectedAgents.some((s) => s.id === a.id);
                        return (
                          <button
                            type="button"
                            key={a.id}
                            onClick={() => toggleAgent(a)}
                            aria-pressed={checked}
                            className="flex w-full items-center gap-2.5 px-[13px] py-2 text-left text-[13px] font-normal text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                          >
                            <span
                              className={`flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border ${
                                checked ? 'border-[color:var(--ui-accent)] bg-[color:var(--ui-accent)] text-white' : 'border-border text-transparent'
                              }`}
                            >
                              <Check size={10} strokeWidth={3} />
                            </span>
                            {a.agentCode}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {roster !== null && roster.length === 0 ? (
                  <div className="mt-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">
                    You have no agents in your roster yet. Contact your administrator if this seems wrong.
                  </div>
                ) : (
                  <div className="mt-1.5 text-[11.5px] text-muted-foreground">{t.agentHint}</div>
                )}
              </div>

              <div className="mb-[22px]">
                <div className="mb-2.5 text-[12.5px] font-bold">{t.step4Details}</div>
                <textarea
                  value={agentDetails}
                  onChange={(e) => setAgentDetails(e.target.value.slice(0, 500))}
                  maxLength={500}
                  placeholder={t.detailsPh}
                  className="min-h-[80px] w-full resize-none rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                />
              </div>
            </>
          )}

          {selectedTitle === 'shop_replacement' && (
            <div className="mb-[22px]">
              <div className="mb-2.5 text-[12.5px] font-bold">
                {t.step2Shop} <span className="text-rose-600 dark:text-rose-400">*</span>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={shopSearch}
                  onChange={(e) => {
                    setShopSearch(e.target.value);
                    setShopDropdownOpen(e.target.value.trim().length > 0);
                  }}
                  placeholder={t.searchShop}
                  className="w-full rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                />
                {shopDropdownOpen && shopMatches.length > 0 && (
                  <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-[180px] overflow-y-auto rounded-[9px] border border-border bg-card shadow-lg">
                    {shopMatches.map((s) => (
                      <button
                        type="button"
                        key={s.id}
                        onClick={() => selectShop(s)}
                        className="block w-full px-[13px] py-2.5 text-left text-[13.5px] text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ui-accent)]"
                      >
                        {s.agentCode}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {selectedShops.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {selectedShops.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-1.5 rounded-[7px] bg-emerald-50 px-2.5 py-1.5 text-[12px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                    >
                      {s.agentCode}
                      <button
                        type="button"
                        onClick={() => setSelectedShops(selectedShops.filter((x) => x.id !== s.id))}
                        aria-label={`Remove ${s.agentCode}`}
                        className="rounded font-extrabold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {roster !== null && roster.length === 0 ? (
                <div className="mt-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">
                  You have no shops in your roster yet. Contact your administrator if this seems wrong.
                </div>
              ) : (
                <div className="mt-1.5 text-[11.5px] text-muted-foreground">{t.shopHint}</div>
              )}
            </div>
          )}

          {selectedTitle === 'adding_new_account' && (
            <>
              <div className="mb-[22px] flex items-start gap-2.5 rounded-[9px] bg-[color:var(--ui-accent-soft)] px-[13px] py-3 text-[12px] text-[color:var(--ui-accent)]">
                <Info size={14} className="mt-0.5 shrink-0" />
                <span>{t.noteNewAccount}</span>
              </div>
              <div className="mb-[22px]">
                <div className="mb-2.5 text-[12.5px] font-bold">
                  {t.step2Daily} <span className="text-rose-600 dark:text-rose-400">*</span>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={dailyLimit}
                  onChange={(e) => setDailyLimit(e.target.value)}
                  placeholder={t.dailyPh}
                  className="w-full rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                />
              </div>
              <div className="mb-[22px]">
                <div className="mb-2.5 text-[12.5px] font-bold">
                  {t.step3Duration} <span className="text-rose-600 dark:text-rose-400">*</span>
                </div>
                <select
                  value={limitDuration}
                  onChange={(e) => setLimitDuration(e.target.value as '' | 'day_shift' | '24_hours')}
                  className="w-full rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                >
                  <option value="">{t.selectDuration}</option>
                  {DURATIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-[22px]">
                <div className="mb-2.5 text-[12.5px] font-bold">
                  {t.step4HowMany} <span className="text-rose-600 dark:text-rose-400">*</span>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={numShops}
                  onChange={(e) => setNumShops(e.target.value)}
                  placeholder={t.howManyPh}
                  className="w-full rounded-[9px] border border-border bg-card px-[13px] py-3 text-[14.5px] text-foreground focus:border-[color:var(--ui-accent)] focus:outline-none"
                />
                <div className="mt-1.5 text-[11.5px] text-muted-foreground">{t.howManyHint}</div>
              </div>
            </>
          )}

          {selectedTitle && (
            <div className="flex items-start gap-2.5 rounded-[9px] bg-[color:var(--ui-accent-soft)] px-[13px] py-3 text-[12px] text-[color:var(--ui-accent)]">
              <Info size={14} className="mt-0.5 shrink-0" />
              <span>{t.noteLeader}</span>
            </div>
          )}

          {submitError && (
            <div className="mt-4 rounded-[9px] border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400">
              {submitError}
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div className="sticky bottom-0 flex gap-3 border-t border-border bg-card px-4 pb-5 pt-3.5">
          <button
            type="button"
            onClick={() => router.push('/tickets')}
            className="flex-1 rounded-[10px] border border-border bg-card px-3 py-[13px] text-[14px] font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)]"
          >
            {t.cancelBtn}
          </button>
          <button
            type="button"
            disabled={!isReady || submitting}
            onClick={handleSubmit}
            className={`flex-[1.4] rounded-[10px] px-3 py-[13px] text-[14px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-accent)] focus-visible:ring-offset-2 ${
              isReady && !submitting
                ? 'cursor-pointer border border-transparent bg-[color:var(--ui-accent)] text-white'
                : 'cursor-not-allowed border border-border bg-card text-muted-foreground'
            }`}
          >
            {submitting ? <Loader2 size={16} className="mx-auto animate-spin" /> : t.submitBtn}
          </button>
        </div>
      </div>
    </div>
  );
}
