// Central registry of downloadable Excel templates — add a new module's
// entry here rather than hardcoding a path at each call site, so a future
// path/filename change (or moving to a new version) only needs updating
// once, in one place. Files live under public/templates/ so they're
// directly static-servable (no API route needed just to serve a static
// file).
export const TEMPLATE_PATHS = {
  settlement: '/templates/settlement-template.xlsx',
  topup: '/templates/topup-template.xlsx',
  openingCashout: '/templates/opening-cashout-template.xlsx',
  openingSendMoney: '/templates/opening-sendmoney-template.xlsx',
  balanceLimitCashout: '/templates/balance-limit-cashout-template.xlsx',
  balanceLimitSendMoney: '/templates/balance-limit-sendmoney-template.xlsx',
} as const;

export type TemplateModule = keyof typeof TEMPLATE_PATHS;

// Triggers an immediate file download via a programmatic, invisible <a
// download> click — no page navigation, no new tab. Both the "+ Add"
// dropdown's "Download Template" item and the Bulk Import modal's own
// "Download Latest Template" button call this same function, so they can
// never point at two different files.
export function downloadTemplate(module: TemplateModule) {
  if (typeof document === 'undefined') return;
  const link = document.createElement('a');
  link.href = TEMPLATE_PATHS[module];
  link.download = '';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
