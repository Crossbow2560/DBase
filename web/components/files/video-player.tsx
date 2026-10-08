"use client";

// <video> with its own buffering indicator. The browser's native loading ring is drawn dark and
// disappears against a black video frame (and can't be restyled), so we overlay a white spinner on
// a translucent backdrop that's visible on any frame, driven by the media element's own events.

import * as React from "react";
import { Loader2 } from "lucide-react";

export function VideoPlayer({ src, className }: { src: string; className?: string }) {
  const [buffering, setBuffering] = React.useState(true);

  return (
    <div className="relative inline-flex max-w-full items-center justify-center bg-black">
      <video
        src={src}
        controls
        autoPlay
        className={className}
        onLoadStart={() => setBuffering(true)}
        onWaiting={() => setBuffering(true)}
        onSeeking={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)}
        onPlaying={() => setBuffering(false)}
        onSeeked={() => setBuffering(false)}
        onError={() => setBuffering(false)}
      />
      {buffering && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-black/70">
            <Loader2 className="h-10 w-10 animate-spin text-white" aria-label="Loading video" />
          </div>
        </div>
      )}
    </div>
  );
}
