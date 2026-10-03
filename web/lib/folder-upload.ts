// Turns what the browser hands us for a folder upload — a drag-and-drop of directories, or an
// <input webkitdirectory> selection — into one flat description: every directory (relative,
// "/"-separated, e.g. "Photos/2024") and every file with the directory it belongs in. The upload
// provider then creates all the directories in one request (POST /folders/tree) and uploads each
// file into its folder.

export interface FolderUploadFile {
  file: File;
  dir: string; // relative directory path, always under one of the selection's root folders
}

export interface FolderSelection {
  roots: string[]; // top-level folder names, in the order they were picked/dropped
  directories: string[]; // every directory, ancestors before descendants; empty ones included
  files: FolderUploadFile[];
}

export interface DroppedItems {
  looseFiles: File[]; // files dropped directly (not inside a dropped folder)
  folders: FolderSelection | null;
}

// Operating-system metadata the user never meant to upload (Finder, Explorer).
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function isIgnoredFile(name: string): boolean {
  return IGNORED_NAMES.has(name);
}

/**
 * A drop's DataTransferItems are only readable during the drop event itself, so the entries are
 * captured synchronously here; walking the directories (asynchronous) happens afterwards.
 */
export async function collectDroppedItems(dataTransfer: DataTransfer): Promise<DroppedItems> {
  const looseFiles: File[] = [];
  const directoryEntries: FileSystemDirectoryEntry[] = [];

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      directoryEntries.push(entry as FileSystemDirectoryEntry);
      continue;
    }
    const file = item.getAsFile();
    if (file && !isIgnoredFile(file.name)) looseFiles.push(file);
  }

  if (directoryEntries.length === 0) return { looseFiles, folders: null };

  const selection: FolderSelection = { roots: [], directories: [], files: [] };
  for (const dir of directoryEntries) {
    selection.roots.push(dir.name);
    await walkDirectory(dir, dir.name, selection);
  }
  return { looseFiles, folders: selection };
}

async function walkDirectory(dir: FileSystemDirectoryEntry, path: string, out: FolderSelection): Promise<void> {
  out.directories.push(path);
  for (const entry of await readAllEntries(dir)) {
    if (entry.isDirectory) {
      await walkDirectory(entry as FileSystemDirectoryEntry, `${path}/${entry.name}`, out);
    } else if (entry.isFile && !isIgnoredFile(entry.name)) {
      out.files.push({ file: await entryFile(entry as FileSystemFileEntry), dir: path });
    }
  }
}

// readEntries() returns directory contents in batches (Chrome: 100 at a time) and must be called
// repeatedly until it returns an empty batch — a single call silently truncates big folders.
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * From an <input type="file" webkitdirectory> selection: each File carries its path relative to
 * the picked folder's parent in webkitRelativePath ("Photos/2024/beach.jpg"). Directories with no
 * files at any depth aren't reported by the browser for this input, so they can't be recreated
 * (drag-and-drop does include them).
 */
export function collectFromDirectoryInput(fileList: FileList): FolderSelection | null {
  const selection: FolderSelection = { roots: [], directories: [], files: [] };
  const seenDirs = new Set<string>();
  const addDir = (path: string) => {
    if (seenDirs.has(path)) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parent) addDir(parent);
    else selection.roots.push(path);
    seenDirs.add(path);
    selection.directories.push(path);
  };

  for (const file of Array.from(fileList)) {
    const relative = file.webkitRelativePath || file.name;
    const slash = relative.lastIndexOf("/");
    if (slash < 0 || isIgnoredFile(file.name)) continue;
    const dir = relative.slice(0, slash);
    addDir(dir);
    selection.files.push({ file, dir });
  }
  return selection.directories.length > 0 ? selection : null;
}
