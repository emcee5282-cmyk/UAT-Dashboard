'use client';

import { useState } from 'react';

export type AvatarUser = { name?: string | null; username?: string | null; avatar?: string | null };

export function avatarInitials(user: AvatarUser | null | undefined): string {
  return (user?.name || user?.username || '··').slice(0, 2).toUpperCase();
}

// The one avatar used by the header button, the account dropdown and the
// Profile modal: the user's photo when they have one, otherwise their
// initials on the fixed indigo circle (the existing default). A photo that
// fails to load falls back to the initials too.
// `initials` overrides the default first-two-letters text; `muted` swaps
// the indigo circle for gray (deactivated accounts on User Management).
export default function UserAvatar({
  user,
  size = 32,
  className = '',
  initials,
  muted = false,
}: {
  user: AvatarUser | null | undefined;
  size?: number;
  className?: string;
  initials?: string;
  muted?: boolean;
}) {
  // Remembers which src failed, so a newly saved photo gets a fresh try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = user?.avatar && user.avatar !== failedSrc ? user.avatar : null;
  // Same text sizes the header used before (10px at 32, 10.5px at 28),
  // scaled up for larger avatars.
  const fontSize = size <= 28 ? 10.5 : size <= 32 ? 10 : Math.round(size * 0.32);

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data: URL, nothing for next/image to optimize
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        onError={() => setFailedSrc(src)}
        decoding="async"
        className={`block shrink-0 rounded-full object-cover ${muted ? 'opacity-60 grayscale' : ''} ${className}`}
        // Fixed display box; the 640px source is scaled down by the browser.
        style={{ width: size, height: size, objectFit: 'cover', borderRadius: '50%' }}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${
        muted ? 'bg-[#E5E7EB] text-[#6B7280] dark:bg-[#262B38] dark:text-[#9198AC]' : 'text-white'
      } ${className}`}
      style={{ width: size, height: size, fontSize, ...(muted ? {} : { background: '#4F46E5' }) }}
    >
      {initials ?? avatarInitials(user)}
    </span>
  );
}
