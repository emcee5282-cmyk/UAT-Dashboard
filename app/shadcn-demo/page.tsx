'use client';

// Scratch/demo page only — not linked in the sidebar, does not touch the
// real app/components/Sidebar.tsx. Explores a floating vertical icon-dock
// layout (inspired by a reference video) for the SAME nav items the real
// Sidebar already has, restyled with shadcn (solid Card/Button, no
// glass/blur) instead of the reference's glassmorphism look.

import { useState } from 'react';
import {
  Home,
  Wallet,
  BookOpen,
  ArrowLeftRight,
  PlusCircle,
  Shuffle,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const DOCK_ITEMS = [
  { key: 'overview', label: 'Overview', icon: Home },
  { key: 'balance', label: 'Balance', icon: Wallet },
  { key: 'opening', label: 'Opening', icon: BookOpen },
  { key: 'settlement', label: 'Settlement', icon: ArrowLeftRight },
  { key: 'topup', label: 'Top Up', icon: PlusCircle },
  { key: 'transfer', label: 'Transfer Queue', icon: Shuffle, badge: 12 },
];

function FloatingDock({ active, onSelect }: { active: string; onSelect: (key: string) => void }) {
  return (
    <div className="fixed right-4 top-1/2 z-50 -translate-y-1/2">
      <div className="flex flex-col items-center gap-1 rounded-full border bg-card p-1.5 shadow-lg">
        {DOCK_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <div key={item.key} className="relative">
              <Button
                type="button"
                variant={isActive ? 'default' : 'ghost'}
                size="icon"
                className="h-10 w-10 rounded-full"
                title={item.label}
                aria-label={item.label}
                onClick={() => onSelect(item.key)}
              >
                <Icon size={17} strokeWidth={1.75} />
              </Button>
              {!!item.badge && (
                <Badge className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[9px]">
                  {item.badge}
                </Badge>
              )}
            </div>
          );
        })}

        <div className="my-1 h-px w-6 bg-border" />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-10 w-10 rounded-full text-muted-foreground"
          title="Settings (coming soon)"
          aria-label="Settings"
          disabled
        >
          <Settings size={17} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

export default function ShadcnSidebarDemo() {
  const [active, setActive] = useState('overview');
  const activeItem = DOCK_ITEMS.find((i) => i.key === active);

  return (
    <div className="min-h-screen bg-background p-6 pr-24 text-foreground">
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-lg font-bold text-foreground">shadcn Demo — Floating Nav Dock</h1>
          <p className="text-sm text-muted-foreground">
            Scratch page only — not linked in the sidebar, does not touch app/components/Sidebar.tsx. Same nav items as the real sidebar, laid out as a floating pill dock (shadcn Button/Card, no glass/blur).
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{activeItem?.label ?? 'Overview'}</CardTitle>
            <CardDescription>Click a dock icon on the right to switch — placeholder content only.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              This is a mock content area standing in for a real page. The dock stays fixed on the right edge regardless of scroll.
            </p>
          </CardContent>
        </Card>

        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="py-4">
              <div className="h-3 w-2/3 rounded bg-muted" />
              <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>

      <FloatingDock active={active} onSelect={setActive} />
    </div>
  );
}
