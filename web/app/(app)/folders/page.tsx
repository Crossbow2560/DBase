import { FolderBrowser } from "@/components/files/folder-browser";

export default function RootFolderPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">My Files</h1>
      <FolderBrowser folderId={null} />
    </div>
  );
}
