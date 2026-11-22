import type { Metadata, Viewport } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Agentforce Voice Templates',
  description:
    'Talk to live Agentforce agents in your browser, and look inside the configuration that makes them work.',
}

export const viewport: Viewport = {
  // `viewport-fit=cover` plus the safe-area padding in globals.css keeps the
  // hang-up button clear of the iPhone home indicator.
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#05060a',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
