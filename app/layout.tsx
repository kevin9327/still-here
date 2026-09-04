import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Still Here — the house checks in',
  description:
    'A Ring Partner API caretaking app for someone living alone: it learns the household rhythm, knocks with the chime when the rhythm breaks, and only calls family if nobody answers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
