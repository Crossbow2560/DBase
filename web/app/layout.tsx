import type { Metadata } from "next";
import { Archivo_Black } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

// Only used by the "alt" theme's page-title styling (globals.css scopes it under
// [data-theme="alt"] h1) — loading it unconditionally here is harmless for the default theme
// since nothing references the --font-display variable it exposes unless that theme is active.
const archivoBlack = Archivo_Black({ subsets: ["latin"], weight: "400", variable: "--font-display" });

export const metadata: Metadata = {
  title: "DBase",
  description: "Self-hosted cloud file storage",
};

// Sets data-theme on <html> before React hydrates, from the same localStorage key
// lib/use-theme.ts reads — without this, the page would always paint the wrong theme first and
// only correct itself once that hook's effect runs after mount, a visible flash on every load.
// Runs as a plain inline script (not a component) specifically so it executes synchronously
// during HTML parsing, before the browser's first paint. "alt" (amber) is the default theme —
// see lib/use-theme.ts's comment — so this only needs to SKIP setting it when the visitor has
// explicitly opted back into the original theme ("default" stored).
const THEME_INIT_SCRIPT = `
  try {
    var t = localStorage.getItem("dbase:theme");
    if (t !== "default") document.documentElement.setAttribute("data-theme", "alt");
  } catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is scoped to this element only (React doesn't propagate it to
    // children) — needed because THEME_INIT_SCRIPT above deliberately adds data-theme to this
    // exact element before React hydrates, which is a real, intentional mismatch against what
    // RootLayout's own JSX rendered server-side (it never sets data-theme itself; lib/use-theme.ts
    // owns that attribute client-side). Without this, React logs a hydration-mismatch error for
    // an attribute difference that's the whole point of the script, not a bug.
    <html lang="en" className={archivoBlack.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
