"use client";

// A multi-segment donut, sibling to ring-chart.tsx's single-value version — same self-contained
// stroked-circle approach, just one <circle> per segment instead of one. Each segment's
// stroke-dasharray is "segment-length, full-circumference" (using the whole circumference as the
// "gap" guarantees the dash pattern never repeats and overlaps itself) and stroke-dashoffset
// shifts that segment's start point to right after the previous ones, so segments read as
// contiguous arcs rather than stacking on top of each other.

export interface RingSegment {
  value: number;
  colorClassName: string;
}

export function MultiRingChart({
  segments,
  size = 140,
  strokeWidth = 14,
  centerLabel,
  centerSublabel,
}: {
  segments: RingSegment[];
  size?: number;
  strokeWidth?: number;
  centerLabel: string;
  centerSublabel?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  let cumulativePercent = 0;

  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={center} cy={center} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-muted" />
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment, i) => {
            const dashArray = `${(Math.min(100, segment.value) / 100) * circumference} ${circumference}`;
            const dashOffset = -(cumulativePercent / 100) * circumference;
            cumulativePercent += segment.value;
            return (
              <circle
                key={i}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                strokeWidth={strokeWidth}
                strokeDasharray={dashArray}
                strokeDashoffset={dashOffset}
                className={segment.colorClassName}
                stroke="currentColor"
              />
            );
          })}
      </svg>
      <div className="absolute flex flex-col items-center justify-center text-center">
        <span className="text-xl font-semibold">{centerLabel}</span>
        {centerSublabel && <span className="text-xs text-muted-foreground">{centerSublabel}</span>}
      </div>
    </div>
  );
}
