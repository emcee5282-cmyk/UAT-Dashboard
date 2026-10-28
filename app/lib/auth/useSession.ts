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
};

// One /api/auth/me request per page load, shared by every component that
// asks (Sidebar, AccountMenu, page buttons) instead of each fetching its own.
let cached: Promise<ClientSession | null> | null = null;

function load(): Promise<ClientSession | null> {
  cached ??= fetch('/api/auth/me')
    .then((res) => (res.ok ? (res.json() as Promise<ClientSession>) : null))
    .catch(() => null);
  return cached;
}

// `undefined` while loading, `null` when signed out.
export function useSession(): ClientSession | null | undefined {
  const [session, setSession] = useState<ClientSession | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    load().then((s) => alive && setSession(s));
    return () => {
      alive = false;
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
