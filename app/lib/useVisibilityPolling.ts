'use client';

import { useEffect, useRef } from 'react';

// Polls `callback` every `intervalMs` while the tab is visible, pausing on
// an explicit tab-hidden event and resuming (with an immediate catch-up
// call) on the matching visible event — hard requirement: never poll
// while the tab is genuinely hidden/backgrounded, to avoid wasted
// requests.
//
// Deliberately does NOT gate on window blur/focus (only on
// document.visibilityState via the visibilitychange event). window blur
// fires whenever the OS moves focus to a *different* top-level window —
// including a second browser window showing this same page fully visible
// on screen (dual monitor, or just clicking into another app) — even
// though document.visibilityState stays 'visible' the whole time (proven
// live: dispatching a real blur event left visibilityState as 'visible'
// but silently froze polling for 10s+ across 2 poll cycles, only resuming
// on the next focus event). A previous version paused on blur too, which
// is exactly what produced the reported "new messages need a click"
// symptom — the click's real effect was restoring window focus, not
// unlocking a stuck render. Tab-hidden (switching away to a different tab
// or minimizing) is a different, legitimate signal and still pauses here.
//
// Also deliberately does NOT gate the initial/ongoing "should I poll"
// state on a static document.hasFocus() read — hasFocus() can read false
// right after a navigation in some browsers/situations even though
// nothing has actually happened yet. Only the real
// visibilitychange-to-hidden EVENT pauses it, so the default state is
// always "polling," and pausing is something that has to actively happen,
// not something that has to be earned.
//
// A ref holds the latest callback so the interval never needs to be torn
// down/recreated just because the caller's closure changed between
// renders — only intervalMs changing does that.
export function useVisibilityPolling(callback: () => void, intervalMs: number) {
  const callbackRef = useRef(callback);

  // Keeping this in its own effect (rather than assigning during render)
  // is required, not just style — refs must only be written outside
  // render (event handlers/effects), per the rules of React.
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let paused = document.visibilityState !== 'visible';

    function stop() {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    }

    function start() {
      stop();
      intervalId = setInterval(() => callbackRef.current(), intervalMs);
    }

    function pause() {
      if (paused) return;
      paused = true;
      stop();
    }

    function resume() {
      if (!paused) return;
      paused = false;
      callbackRef.current();
      start();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') resume();
      else pause();
    }

    if (!paused) start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs]);
}
