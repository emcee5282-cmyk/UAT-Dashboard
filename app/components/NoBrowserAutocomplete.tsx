'use client';

import { useEffect } from 'react';

// App-wide: stop the browser's saved-entries popup (Chrome's "previously
// typed" list) from opening over our own dropdowns and fields — it showed
// stale brands/amounts on top of the record forms. Every text-like input
// without its own autocomplete gets autocomplete="off", including inputs
// added later (modals, new pages). Inputs that set autoComplete themselves
// (Login, Change Password — password-manager support) are left alone.
const SELECTOR = 'input:not([autocomplete]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea:not([autocomplete])';

function apply(root: ParentNode) {
  root.querySelectorAll(SELECTOR).forEach((el) => el.setAttribute('autocomplete', 'off'));
}

export default function NoBrowserAutocomplete() {
  useEffect(() => {
    apply(document);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(SELECTOR)) node.setAttribute('autocomplete', 'off');
          apply(node);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
