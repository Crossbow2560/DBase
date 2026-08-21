import { FolderBrowser } from "@/components/files/folder-browser";

// Next.js 15: `params` is a Promise. This page has no client-side hooks of its own, so it can
// stay a Server Component and just await it directly.
export default async function FolderPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = await params;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Folder</h1>
      <FolderBrowser folderId={folderId} />
    </div>
  );
}
