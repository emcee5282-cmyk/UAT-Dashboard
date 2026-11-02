'use client';

import { useEffect, useState } from 'react';
import type { Permission } from './permissions';

export type ClientSession = {
  username: string;
  name: string | null;
  role: string;
  roleLabel: string;
  permissions: Permission[];
  mustChangePassword: boolean;
  avatar: string | null;
};

// One /api/auth/me request per page load, shared by every component that
// asks (Sidebar, AccountMenu, page buttons) instead of each fetching its own.
let cached: Promise<ClientSession | null> | null = null;
// Every mounted useSession(), so a local change (new profile photo) reaches
// all of them at once without a refetch or reload.
const listeners = new Set<(session: ClientSession | null) => void>();

function load(): Promise<ClientSession | null> {
  cached ??= fetch('/api/auth/me')
    .then((res) => (res.ok ? (res.json() as Promise<ClientSession>) : null))
    .catch(() => null);
  return cached;
}

// Merges a change the server has already accepted into the shared session
// and re-renders every consumer (e.g. the header avatar after Save).
export async function updateSession(patch: Partial<ClientSession>): Promise<void> {
  const current = await load();
  if (!current) return;
  const next = { ...current, ...patch };
  cached = Promise.resolve(next);
  for (const listener of listeners) listener(next);
}

// `undefined` while loading, `null` when signed out.
export function useSession(): ClientSession | null | undefined {
  const [session, setSession] = useState<ClientSession | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const listener = (s: ClientSession | null) => alive && setSession(s);
    listeners.add(listener);
    load().then((s) => alive && setSession(s));
    return () => {
      alive = false;
      listeners.delete(listener);
    };
  }, []);
  return session;
}

// UI-only convenience for hiding buttons — every API route enforces the
// same permission server-side regardless. False while loading, so edit
// controls never flash in for a read-only role.
export function useCan(permission: Permission): boolean {
  const session = useSession();
  return !!session?.permissions.includes(permission);
}
