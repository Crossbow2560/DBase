// Public landing page — the only route outside the (app)/(auth) route groups that serves
// logged-out visitors real content instead of redirecting immediately. Server Component (not
// "use client") so this HTML is actually present in the initial response for crawlers/scrapers
// and so the page can export its own <title>/description below. The one bit of this page that
// needs the browser (redirect an already-logged-in visitor on to /home) is split out into
// <LandingRedirect>, a small client component that renders nothing and just runs that effect.
//
// This page has its own fixed "technical drafting / blueprint" visual system (cream paper,
// ink-black, mustard accent, hard-edged borders, hard-offset shadows, Plus Jakarta Sans +
// JetBrains Mono) rather than the app's theme tokens — it's a deliberately distinct look from
// the rest of the app, not meant to shift with the light/dark/amber theme toggle.
import type { Metadata } from "next";
import type * as React from "react";
import Link from "next/link";
import { LandingRedirect } from "@/components/landing-redirect";

export const metadata: Metadata = {
  title: "DBase - Simple file storage you control",
  description:
    "Self-hosted cloud file storage: uploads that resume, nested folders, sharing with view/edit access, private tags, favorites, a recoverable trash, and honestly enforced storage quotas.",
};

const INK = "#0F172A";
const CREAM = "#F4F1E8";
const MUSTARD = "#D49D42";
const PARCHMENT = "#F0EDE2";
const OUTLINE = "#827565";
const OUTLINE_VARIANT = "#D4C4B1";
const ON_SURFACE_VARIANT = "#504537";

const jakarta = "font-['Plus_Jakarta_Sans']";
const mono = "font-['JetBrains_Mono']";

function Icon({
  name,
  className = "",
  style,
}: {
  name: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className={`material-symbols-outlined ${className}`} style={style} aria-hidden>
      {name}
    </span>
  );
}

export default function RootPage() {
  return (
    <div
      className={`min-h-screen flex flex-col ${mono}`}
      style={{
        color: INK,
        backgroundColor: CREAM,
        backgroundImage: `radial-gradient(${OUTLINE_VARIANT} 1.5px, transparent 1.5px)`,
        backgroundSize: "24px 24px",
      }}
    >
      <LandingRedirect />

      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
      />
      <style>{`
        .material-symbols-outlined {
          font-family: 'Material Symbols Outlined';
          font-weight: normal;
          font-style: normal;
          font-size: 24px;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          white-space: nowrap;
          word-wrap: normal;
          direction: ltr;
        }
      `}</style>

      {/* Top App Bar */}
      <header
        className="w-full top-0 left-0 border-b flex justify-between items-center h-16 px-4 md:px-8 sticky z-50 backdrop-blur-sm"
        style={{ borderColor: INK, backgroundColor: `${CREAM}E6` }}
      >
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2" style={{ color: INK }}>
            <img src="/logo.png" alt="" className="h-8 w-8 shrink-0 object-contain" />
            <span className={`${jakarta} text-lg font-bold`}>DBase</span>
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className={`${mono} text-[11px] leading-4 tracking-[0.1em] font-semibold border px-4 py-2 flex items-center justify-center`}
            style={{ borderColor: INK, color: INK }}
          >
            Log In
          </Link>
          <Link
            href="/register"
            className={`${mono} text-[11px] leading-4 tracking-[0.1em] font-semibold border px-4 py-2 flex items-center justify-center`}
            style={{ borderColor: INK, color: INK, backgroundColor: MUSTARD, boxShadow: `4px 4px 0 0 ${INK}` }}
          >
            Sign Up
          </Link>
        </div>
      </header>

      <main className="flex-grow w-full max-w-7xl mx-auto px-4 md:px-8 py-12 md:py-24">
        {/* Hero */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center mb-32 border-b pb-16" style={{ borderColor: INK }}>
          <div className="flex flex-col gap-6">
            <h1
              className="text-[32px] leading-[40px] sm:text-[48px] sm:leading-[56px]"
              style={{
                fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              Simple file storage you control.
            </h1>
            <p className="text-base leading-6 max-w-md" style={{ color: ON_SURFACE_VARIANT }}>
              All in one cloud storage at your fingertips.
            </p>
            <div className="flex flex-wrap gap-4 mt-4">
              <Link
                href="/register"
                className={`${mono} text-[11px] leading-4 tracking-[0.1em] font-semibold border px-6 py-3 transition-colors flex items-center gap-2 hover:opacity-90`}
                style={{ backgroundColor: INK, color: "#fff", borderColor: INK }}
              >
                Get started <Icon name="arrow_forward" className="text-sm" />
              </Link>
              <Link
                href="/login"
                className={`${mono} text-[11px] leading-4 tracking-[0.1em] font-semibold border px-6 py-3 transition-colors bg-transparent hover:bg-black/5 flex items-center justify-center`}
                style={{ borderColor: INK, color: INK }}
              >
                Log in
              </Link>
            </div>
          </div>

          <div className="relative h-96 border overflow-hidden" style={{ borderColor: INK, backgroundColor: PARCHMENT }}>
            <div
              className="absolute inset-0 opacity-50"
              style={{
                backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 10px, #E2E0D6 10px, #E2E0D6 11px)`,
              }}
            />
            <div
              className="absolute top-8 left-8 right-8 bottom-8 border p-4 flex flex-col gap-4 shadow-xl shadow-black/10 backdrop-blur-md"
              style={{ borderColor: INK, backgroundColor: `${CREAM}E6` }}
            >
              <div className="flex justify-between items-center border-b pb-2" style={{ borderColor: INK }}>
                <span className={`${mono} text-[11px] leading-4 tracking-[0.1em] font-semibold`}>SYS.ROOT / My Files</span>
                <div className="flex gap-2">
                  <div className="w-2 h-2 rounded-full border" style={{ borderColor: INK, backgroundColor: MUSTARD }} />
                  <div className="w-2 h-2 rounded-full border" style={{ borderColor: INK }} />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-3 p-2 border bg-white" style={{ borderColor: `${INK}4D` }}>
                  <Icon name="folder" className="text-base" />
                  <span className="text-sm leading-5">Project_Alpha_Specs</span>
                  <span className={`${mono} ml-auto text-xs leading-4`} style={{ color: OUTLINE }}>
                    --
                  </span>
                </div>
                <div className="flex items-center gap-3 p-2 border bg-white" style={{ borderColor: `${INK}4D` }}>
                  <Icon name="draft" className="text-base" style={{ color: OUTLINE }} />
                  <span className="text-sm leading-5">node_config_v2.json</span>
                  <span className={`${mono} ml-auto text-xs leading-4`} style={{ color: OUTLINE }}>
                    14.2 KB
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Feature grid */}
        <section className="mb-32">
          <div className="mb-12 flex justify-between items-end border-b pb-4" style={{ borderColor: INK }}>
            <h2 className={`${jakarta} text-[32px] leading-[40px] font-bold`}>What&apos;s actually in it</h2>
            <span
              className={`${mono} hidden md:block text-[11px] leading-4 tracking-[0.1em] font-semibold`}
              style={{ color: OUTLINE }}
            >
              System Capabilities Overview
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-[250px]">
            {/* Uploads — large span */}
            <div
              className="col-span-1 md:col-span-2 border bg-white flex flex-col justify-between p-6 relative transition-colors hover:bg-[#F0EDE2]"
              style={{ borderColor: INK }}
            >
              <div
                className="absolute top-0 right-0 w-16 h-16 border-l border-b flex items-center justify-center"
                style={{ borderColor: INK, backgroundColor: MUSTARD }}
              >
                <Icon name="upload_file" />
              </div>
              <div className={`${mono} text-[11px] leading-4 tracking-[0.1em] font-semibold mb-2`} style={{ color: MUSTARD }}>
                01 // Transfer
              </div>
              <div>
                <h3 className={`${jakarta} text-2xl leading-8 font-semibold mb-2`}>Uploads that don&apos;t lose progress</h3>
                <p className="text-sm leading-5 max-w-md" style={{ color: ON_SURFACE_VARIANT }}>
                  Drag files in, pause if you need to, resume later. Nothing restarts from zero. Engineered for
                  unstable connections.
                </p>
              </div>
            </div>

            {/* Folders */}
            <div
              className="col-span-1 border flex flex-col justify-between p-6 transition-colors hover:bg-white"
              style={{ borderColor: INK, backgroundColor: PARCHMENT }}
            >
              <div>
                <Icon name="account_tree" className="mb-4 text-3xl" />
                <h3 className={`${jakarta} text-lg font-semibold mb-2`}>Folders, however deep you want</h3>
                <p className="text-sm leading-5" style={{ color: ON_SURFACE_VARIANT }}>
                  Nest them as much as makes sense to you. Switch to grid view if you&apos;d rather see thumbnails.
                </p>
              </div>
            </div>

            {/* Share */}
            <div className="col-span-1 border flex flex-col justify-between p-6" style={{ borderColor: INK, backgroundColor: INK, color: "#fff" }}>
              <div>
                <Icon name="share" className="mb-4 text-3xl" style={{ color: MUSTARD }} />
                <h3 className={`${jakarta} text-lg font-semibold mb-2`}>Share when you actually need to</h3>
                <p className="text-sm leading-5" style={{ color: OUTLINE_VARIANT }}>
                  Give someone view or edit access, or just hand out a link. Cryptographically secure routing.
                </p>
              </div>
              <div className={`${mono} mt-4 border-t pt-4 text-xs leading-4 flex justify-between`} style={{ borderColor: `${OUTLINE}4D` }}>
                <span style={{ color: MUSTARD }}>View Access</span>
                <span style={{ color: OUTLINE_VARIANT }}>Edit Access</span>
              </div>
            </div>

            {/* Tags */}
            <div className="col-span-1 border bg-white flex flex-col justify-between p-6 relative" style={{ borderColor: INK }}>
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 10px, ${MUSTARD} 10px, ${MUSTARD} 11px)`,
                }}
              />
              <div className="absolute inset-0 m-2 border bg-white/90 p-4 flex flex-col justify-between" style={{ borderColor: `${INK}33` }}>
                <div>
                  <Icon name="label" className="mb-2" />
                  <h3 className={`${jakarta} text-lg font-semibold mb-1`}>Your own tags</h3>
                  <p className="text-sm leading-5" style={{ color: ON_SURFACE_VARIANT }}>
                    Label things your way — private to you, even on stuff someone else owns.
                  </p>
                </div>
                <div className="flex gap-2">
                  <span
                    className={`${mono} border px-2 py-1 text-[9px] leading-3 tracking-[0.1em] font-semibold`}
                    style={{ borderColor: INK, backgroundColor: PARCHMENT }}
                  >
                    URGENT
                  </span>
                  <span
                    className={`${mono} border px-2 py-1 text-[9px] leading-3 tracking-[0.1em] font-semibold`}
                    style={{ borderColor: INK, backgroundColor: `${MUSTARD}33` }}
                  >
                    FINANCE
                  </span>
                </div>
              </div>
            </div>

            {/* Favorites + Trash, stacked */}
            <div className="col-span-1 flex flex-col gap-6 h-full">
              <div className="flex-1 border bg-white p-4 flex items-start gap-4" style={{ borderColor: INK }}>
                <div className="w-10 h-10 border flex items-center justify-center shrink-0" style={{ borderColor: INK }}>
                  <Icon name="star" style={{ color: MUSTARD }} />
                </div>
                <div>
                  <h3 className={`${jakarta} text-base leading-6 font-semibold mb-1`}>Favorites</h3>
                  <p className="text-xs leading-4" style={{ color: ON_SURFACE_VARIANT }}>
                    Star the stuff you keep going back to so you&apos;re not digging for it.
                  </p>
                </div>
              </div>
              <div className="flex-1 border border-dashed p-4 flex items-start gap-4" style={{ borderColor: INK, backgroundColor: PARCHMENT }}>
                <div
                  className="w-10 h-10 border flex items-center justify-center shrink-0"
                  style={{ borderColor: INK, backgroundColor: INK, color: "#fff" }}
                >
                  <Icon name="delete" />
                </div>
                <div>
                  <h3 className={`${jakarta} text-base leading-6 font-semibold mb-1`}>A trash that isn&apos;t final</h3>
                  <p className="text-xs leading-4" style={{ color: ON_SURFACE_VARIANT }}>
                    Deleted things sit around for a bit before they&apos;re actually gone.
                  </p>
                </div>
              </div>
            </div>

            {/* Storage limits + quota mockup — wide */}
            <div className="col-span-1 md:col-span-3 border bg-white flex flex-col md:flex-row" style={{ borderColor: INK }}>
              <div className="p-6 md:w-1/3 border-b md:border-b-0 md:border-r flex flex-col justify-center" style={{ borderColor: INK }}>
                <h3 className={`${jakarta} text-2xl leading-8 font-semibold mb-2`}>Storage limits, tracked honestly</h3>
                <p className="text-sm leading-5" style={{ color: ON_SURFACE_VARIANT }}>
                  Every account has a quota that&apos;s enforced as you upload, not discovered later.
                </p>
              </div>
              <div className="p-6 md:w-2/3 flex items-center justify-center" style={{ backgroundColor: PARCHMENT }}>
                <div className="w-full max-w-md border bg-white p-4" style={{ borderColor: INK }}>
                  <div className={`${mono} flex justify-between text-[11px] leading-4 tracking-[0.1em] font-semibold mb-2`}>
                    <span>Storage Quota</span>
                    <span>420 GB / 1 TB</span>
                  </div>
                  <div className="h-2 w-full border overflow-hidden flex" style={{ borderColor: INK, backgroundColor: PARCHMENT }}>
                    <div className="h-full border-r" style={{ width: "42%", backgroundColor: MUSTARD, borderColor: INK }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section
          className="border p-8 md:p-16 flex flex-col items-center text-center relative overflow-hidden"
          style={{ borderColor: INK, backgroundColor: MUSTARD, boxShadow: `4px 4px 0 0 ${INK}` }}
        >
          <div className="absolute top-4 left-4 w-4 h-4 border-t border-l" style={{ borderColor: INK }} />
          <div className="absolute top-4 right-4 w-4 h-4 border-t border-r" style={{ borderColor: INK }} />
          <div className="absolute bottom-4 left-4 w-4 h-4 border-b border-l" style={{ borderColor: INK }} />
          <div className="absolute bottom-4 right-4 w-4 h-4 border-b border-r" style={{ borderColor: INK }} />

          <h2 className={`${jakarta} text-[32px] leading-[40px] sm:text-[48px] sm:leading-[56px] tracking-[-0.02em] font-bold mb-4`}>
            Give it a try
          </h2>
          <p className="text-base leading-6 max-w-lg mb-8" style={{ color: `${INK}CC` }}>
            Making an account takes a minute, and your first folder is one click away. Experience structured,
            controlled storage.
          </p>
          <Link
            href="/register"
            className={`${mono} text-base leading-6 tracking-[0.1em] font-semibold border px-8 py-4 transition-colors hover:opacity-90 flex items-center justify-center w-fit`}
            style={{ backgroundColor: INK, color: "#fff", borderColor: INK }}
          >
            Create an account
          </Link>
        </section>
      </main>

      <footer
        className="w-full border-t mt-auto flex flex-col md:flex-row justify-between items-center px-4 md:px-8 py-2 gap-4"
        style={{ borderColor: INK, backgroundColor: PARCHMENT }}
      >
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="" className="h-8 w-8 shrink-0 object-contain" />
          <span className={`${jakarta} text-lg font-bold`}>DBase</span>
        </div>
        <nav className={`${mono} flex gap-4 text-xs leading-4 tracking-[0.1em]`} style={{ color: ON_SURFACE_VARIANT }}>
          <a className="hover:underline decoration-2 underline-offset-4" style={{ textDecorationColor: MUSTARD }} href="#">
            System Status
          </a>
          <a
            className="hover:underline decoration-2 underline-offset-4"
            style={{ textDecorationColor: MUSTARD }}
            href="mailto:nishit.bilimagga@gmail.com"
          >
            Contact Me
          </a>
        </nav>
      </footer>
    </div>
  );
}
