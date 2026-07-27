'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getActiveProduct, getCounterpartPath, isProductSwitchRoute } from '@/app/lib/productRoutes';

type ProductSwitchTabsProps = {
  // 'text' (default) is the original plain-text tab look used by every
  // PageHeader consumer — unchanged. 'segmented' is a Settlement-only pill
  // control (Stripe/Linear style) added for SettlementHeader; it reuses the
  // exact same route-detection/navigation logic below, just different JSX.
  variant?: 'text' | 'segmented';
};

// Cashout/Send Money switcher — extracted out of the old FloatingHeader's
// inline logic so PageHeader itself can stay generic (product-switching is
// specific to the pages that have both variants, not every future module).
// Fully self-contained: reads pathname/searchParams itself, renders nothing
// on routes that don't have a Send Money counterpart.
export default function ProductSwitchTabs({ variant = 'text' }: ProductSwitchTabsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Sliding active-pill indicator (segmented variant only) — a real
  // measured background element that animates its left/width via CSS
  // transition, rather than each button independently swapping its own
  // bg-white on click (which read as an instant swap, not a "slide"). Every
  // hook here is declared unconditionally, ABOVE the early return below and
  // outside any `if` — even though they're inert for the 'text' variant and
  // on non-product-switch routes — since hook call order can never depend
  // on a prop value or an early return.
  const containerRef = useRef<HTMLDivElement>(null);
  const cashoutRef = useRef<HTMLButtonElement>(null);
  const sendMoneyRef = useRef<HTMLButtonElement>(null);
  const [pillStyle, setPillStyle] = useState<{ left: number; width: number } | null>(null);
  const activeProductForPill = isProductSwitchRoute(pathname) ? getActiveProduct(pathname, searchParams.get('product')) : null;

  useLayoutEffect(() => {
    if (variant !== 'segmented' || !activeProductForPill) return;
    const activeButton = activeProductForPill === 'cashout' ? cashoutRef.current : sendMoneyRef.current;
    const container = containerRef.current;
    if (!activeButton || !container) return;
    const containerRect = container.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    setPillStyle({ left: buttonRect.left - containerRect.left, width: buttonRect.width });
  }, [variant, activeProductForPill]);

  if (!isProductSwitchRoute(pathname)) return null;

  const activeProduct = getActiveProduct(pathname, searchParams.get('product'));

  const goToProduct = (target: 'cashout' | 'sendmoney') => {
    router.push(getCounterpartPath(pathname, target));
  };

  if (variant === 'segmented') {
    const segmentClass = (isActive: boolean) =>
      `relative z-10 rounded-md px-3 py-1 text-[12px] font-medium transition-colors duration-150 ease-out ${
        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`;

    return (
      <div ref={containerRef} className="relative inline-flex items-center gap-1 rounded-lg bg-muted/50 p-1">
        {pillStyle && (
          <div
            className="absolute top-1 bottom-1 rounded-md bg-white shadow-sm transition-[left,width] duration-200 ease-out dark:bg-[#2a2a2d]"
            style={{ left: pillStyle.left, width: pillStyle.width }}
          />
        )}
        <button ref={cashoutRef} type="button" onClick={() => goToProduct('cashout')} className={segmentClass(activeProduct === 'cashout')}>
          Cashout
        </button>
        <button ref={sendMoneyRef} type="button" onClick={() => goToProduct('sendmoney')} className={segmentClass(activeProduct === 'sendmoney')}>
          Send Money
        </button>
      </div>
    );
  }

  const tabClass = (isActive: boolean) =>
    `text-[12px] transition-colors duration-200 ease-out ${
      isActive ? 'font-bold text-foreground' : 'font-medium text-muted-foreground hover:font-semibold hover:text-foreground/80'
    }`;

  return (
    <div className="flex items-center gap-7">
      <button type="button" onClick={() => goToProduct('cashout')} className={tabClass(activeProduct === 'cashout')}>
        Cashout
      </button>
      <button type="button" onClick={() => goToProduct('sendmoney')} className={tabClass(activeProduct === 'sendmoney')}>
        Send Money
      </button>
    </div>
  );
}
