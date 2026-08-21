"use client";

// Preserved copy of the original polished/corporate-styled landing page, kept as-is at this
// separate route per explicit request after the root "/" page was toned down — not linked from
// anywhere in the app's nav, reachable directly at /landing-pro if you want to compare or revert.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Upload,
  Folder,
  Share2,
  Tag,
  Star,
  Trash2,
  ShieldCheck,
  Users,
  ArrowRight,
  LayoutGrid,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const FEATURES = [
  {
    icon: Upload,
    title: "Resumable uploads",
    description: "Drag files in or browse to pick them. Pause, resume, or cancel mid-upload without losing progress.",
  },
  {
    icon: Folder,
    title: "Folder organization",
    description: "Nest folders as deep as you need, move things around, and switch between list and grid views.",
  },
  {
    icon: Share2,
    title: "Granular sharing",
    description: "Share a file or folder with specific people as a viewer or editor, or hand out a public link.",
  },
  {
    icon: Tag,
    title: "Personal tags",
    description: "Label anything with your own tags — private to you, even on items someone else owns.",
  },
  {
    icon: Star,
    title: "Favorites",
    description: "Star what you come back to often and find it instantly, without digging through folders.",
  },
  {
    icon: Trash2,
    title: "Recoverable trash",
    description: "Deleted items sit in trash before they're gone for good, so a mis-click isn't permanent.",
  },
  {
    icon: ShieldCheck,
    title: "Per-account storage quotas",
    description: "Every account gets its own tracked quota, enforced as uploads happen — not after the fact.",
  },
  {
    icon: Users,
    title: "Admin oversight",
    description: "Administrators can review accounts, activity, and storage usage across the whole workspace.",
  },
];

export default function LandingProPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && user) {
      router.replace("/home");
    }
  }, [isLoading, user, router]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      {/* Decorative gradient blobs — purely visual, positioned behind everything. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-40 -left-32 h-[32rem] w-[32rem] rounded-full bg-[#4A7FA7]/25 blur-3xl" />
        <div className="absolute top-1/3 -right-40 h-[36rem] w-[36rem] rounded-full bg-[#B3CFE5]/50 blur-3xl" />
        <div className="absolute bottom-0 left-1/4 h-[28rem] w-[28rem] rounded-full bg-[#1A3D63]/10 blur-3xl" />
      </div>

      <div className="relative">
        {/* Nav */}
        <header className="sticky top-0 z-20 border-b border-border/60 bg-background/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <LayoutGrid className="h-4 w-4" aria-hidden />
              </div>
              <span className="text-sm font-semibold">DBase</span>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Log in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">Sign up</Link>
              </Button>
            </div>
          </div>
        </header>

        {/* Hero */}
        <section className="mx-auto max-w-5xl px-6 pb-24 pt-20 text-center sm:pt-28">
          <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden />
            Self-hosted file storage
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl md:text-6xl">
            Your files, organized and{" "}
            <span className="bg-gradient-to-r from-[#1A3D63] to-[#4A7FA7] bg-clip-text text-transparent">
              under your control
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Upload, organize, and share files across folders you structure yourself — with sharing
            permissions, tags, favorites, and a trash you can recover from, all in one place.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/register">
                Get started
                <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/login">Log in to your account</Link>
            </Button>
          </div>

          {/* Preview card — a stylized glass mockup of the actual file browser, not a screenshot
              claiming real numbers. */}
          <div className="relative mx-auto mt-16 max-w-3xl">
            <div className="overflow-hidden rounded-2xl border border-border/60 bg-background/60 shadow-2xl shadow-[#1A3D63]/10 backdrop-blur-xl">
              <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-[#4A7FA7]/40" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#B3CFE5]" />
                <span className="h-2.5 w-2.5 rounded-full bg-accent/40" />
                <span className="ml-3 text-xs text-muted-foreground">My Files</span>
              </div>
              <div className="grid grid-cols-4 gap-3 p-5 sm:grid-cols-5">
                {[Folder, Folder, Upload, Share2, Tag, Star].map((Icon, i) => (
                  <div
                    key={i}
                    className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/70"
                  >
                    <Icon className="h-5 w-5 text-accent" aria-hidden />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-6xl px-6 pb-28">
          <div className="mx-auto mb-12 max-w-xl text-center">
            <h2 className="text-2xl font-semibold sm:text-3xl">Everything you need to manage your files</h2>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">
              No bloat, no surprises — just the tools that make a file store actually useful day to day.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="group rounded-2xl border border-border/60 bg-background/50 p-5 backdrop-blur-md transition-colors hover:bg-background/80"
              >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[#B3CFE5]/60 to-[#4A7FA7]/30 text-accent">
                  <feature.icon className="h-5 w-5" aria-hidden />
                </div>
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-4xl px-6 pb-28">
          <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-[#1A3D63] to-[#4A7FA7] px-8 py-14 text-center shadow-xl">
            <div
              className="pointer-events-none absolute -top-16 -right-16 h-64 w-64 rounded-full bg-white/10 blur-3xl"
              aria-hidden
            />
            <h2 className="text-2xl font-semibold text-white sm:text-3xl">Ready to get organized?</h2>
            <p className="mx-auto mt-3 max-w-md text-sm text-white/80 sm:text-base">
              Create an account and start uploading — your first folder is one click away.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="bg-white text-[#0A1931] hover:bg-white/90">
                <Link href="/register">
                  Create your account
                  <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border/60 px-6 py-8">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <LayoutGrid className="h-3 w-3" aria-hidden />
              </div>
              <span>DBase</span>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/login" className="hover:text-foreground">
                Log in
              </Link>
              <Link href="/register" className="hover:text-foreground">
                Sign up
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
