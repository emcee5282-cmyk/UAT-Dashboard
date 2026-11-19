// Neutral tab title/description before login (no company name). The page
// itself is unchanged — internal users share it.
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Tracker',
  description: 'Sign in',
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
