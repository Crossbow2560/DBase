"use client";

// Public landing page — the only route outside the (app)/(auth) route groups that serves
// logged-out visitors real content instead of redirecting immediately. An already-logged-in
// visitor is sent on to /home once auth resolves, same client-side-only pattern (auth)/layout.tsx
// already uses for the opposite redirect, and the same accepted flash-of-landing-content tradeoff.
//
// Deliberately understated rather than polished-SaaS — this is a personal project, not a product
// with a marketing budget, and it reads better honest about that than dressed up as something
// bigger than it is. The earlier, glossier version is kept as-is at /landing-pro if it's wanted
// back — this file replaces it at "/" but doesn't delete it.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Upload, Folder, FileText, Share2, Tag, Star, Trash2, Gauge, Users, ArrowRight, LayoutGrid } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const FEATURES = [
  { icon: Upload, title: "Uploads that don't lose progress", description: "Drag files in, pause if you need to, resume later. Nothing restarts from zero." },
  { icon: Folder, title: "Folders, however deep you want", description: "Nest them as much as makes sense to you. Switch to grid view if you'd rather see thumbnails." },
  { icon: Share2, title: "Share when you actually need to", description: "Give someone view or edit access, or just hand out a link." },
  { icon: Tag, title: "Your own tags", description: "Label things your way — private to you, even on stuff someone else owns." },
  { icon: Star, title: "Favorites", description: "Star the stuff you keep going back to so you're not digging for it." },
  { icon: Trash2, title: "A trash that isn't final", description: "Deleted things sit around for a bit before they're actually gone." },
  { icon: Gauge, title: "Storage limits, tracked honestly", description: "Every account has a quota that's enforced as you upload, not discovered later." },
  { icon: Users, title: "Basic admin tools", description: "Enough to see who's on the workspace and how much space they're using." },
];

export default function RootPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && user) {
      router.replace("/home");
    }
  }, [isLoading, user, router]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-32 -left-24 h-96 w-96 rounded-full bg-[#B3CFE5]/40 blur-3xl" />
        <div className="absolute top-1/2 -right-24 h-80 w-80 rounded-full bg-[#4A7FA7]/15 blur-3xl" />
      </div>

      <div className="relative">
        <header className="border-b border-border/60 px-6 py-4">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
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

        <section className="mx-auto max-w-3xl px-6 pb-20 pt-16 text-center sm:pt-24">
          <h1 className="mx-auto max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Simple file storage you control
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground">
            All in one cloud storage at your fingertips.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/register">
                Get started
                <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/login">Log in</Link>
            </Button>
          </div>

          <div className="relative mx-auto mt-14 max-w-2xl">
            <div className="overflow-hidden rounded-xl border border-border bg-background/70 backdrop-blur-md">
              <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-2">
                <span className="h-2 w-2 rounded-full bg-[#B3CFE5]" />
                <span className="h-2 w-2 rounded-full bg-accent/40" />
                <span className="ml-2 text-xs text-muted-foreground">My Files</span>
              </div>
              <div className="grid grid-cols-4 gap-2.5 p-4 sm:grid-cols-6">
                {[Folder, FileText, Upload, Share2, Tag, Star].map((Icon, i) => (
                  <div
                    key={i}
                    className="flex aspect-square items-center justify-center rounded-lg border border-border bg-background/60"
                  >
                    <Icon className="h-4 w-4 text-accent" aria-hidden />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 pb-20">
          <h2 className="mb-8 text-center text-xl font-semibold">What's actually in it</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="flex gap-3 rounded-xl border border-border/70 bg-background/40 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
                  <feature.icon className="h-4.5 w-4.5" aria-hidden />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">{feature.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{feature.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-2xl px-6 pb-24 text-center">
          <div className="rounded-2xl border border-border bg-muted/30 px-8 py-10">
            <h2 className="text-lg font-semibold">Give it a try</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Making an account takes a minute, and your first folder is one click away.
            </p>
            <Button asChild className="mt-6">
              <Link href="/register">
                Create an account
                <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </div>
        </section>

        <footer className="border-t border-border/60 px-6 py-6 text-center text-xs text-muted-foreground">
          DBase
        </footer>
      </div>
    </div>
  );
}
