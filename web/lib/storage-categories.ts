// Shared between the per-user Storage Capacity card (app/(app)/home/page.tsx) and the admin
// stats page's system-wide/per-user donuts — both consume the same {category, bytes}[] shape
// from the backend (accounts/service.ts's getStorageBreakdown/getSystemStorageBreakdown), so the
// label/color mapping lives here once instead of duplicated per page.
export const CATEGORY_META = {
  documents: { label: "Documents", textClass: "text-accent", bgClass: "bg-accent" },
  images: { label: "Images", textClass: "text-violet-400", bgClass: "bg-violet-400" },
  videos: { label: "Videos", textClass: "text-foreground", bgClass: "bg-foreground" },
} as const;

export interface StorageBreakdown {
  categories: { category: "documents" | "images" | "videos"; bytes: string }[];
}
