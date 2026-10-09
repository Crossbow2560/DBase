// Filename rules for the two platforms dbase-sync supports. DBase stores names NFC-normalized,
// up to 255 bytes, unique per folder (case-sensitively). Linux accepts all of those; Windows
// doesn't accept some names at all and treats names that differ only by case as the same file.

export type Platform = "linux" | "win32";

export const currentPlatform = (): Platform => (process.platform === "win32" ? "win32" : "linux");

export function normalizeName(name: string): string {
  return name.normalize("NFC");
}

const WINDOWS_FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Why `name` can't be stored as a file/folder name on this platform, or null if it can.
 * Unsyncable items are skipped and reported, never renamed behind the user's back.
 */
export function unsyncableReason(name: string, platform: Platform = currentPlatform()): string | null {
  if (name === "." || name === "..") return "reserved name";
  if (name.includes("/") || name.includes("\u0000")) return "contains '/' or a NUL character";
  if (Buffer.byteLength(name, "utf8") > 255) return "longer than 255 bytes";
  if (platform === "win32") {
    if (WINDOWS_FORBIDDEN_CHARS.test(name)) return 'contains a character Windows forbids (<>:"/\\|?* or a control character)';
    if (WINDOWS_RESERVED.test(name)) return "a reserved device name on Windows";
    if (/[. ]$/.test(name)) return "ends with a dot or space, which Windows drops";
  }
  return null;
}

/** The key two names collide under on this platform's filesystem. */
export function collisionKey(name: string, platform: Platform = currentPlatform()): string {
  const nfc = normalizeName(name);
  return platform === "win32" ? nfc.toLowerCase() : nfc;
}

/**
 * `report (conflicted copy laptop 2026-10-09).pdf` — the name a losing local version is kept
 * under when both sides changed. `taken` is checked so repeated conflicts never collide.
 */
export function conflictedCopyName(name: string, host: string, date: Date, taken: (candidate: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const day = date.toISOString().slice(0, 10);
  const safeHost = host.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = `${stem} (conflicted copy ${safeHost} ${day}${suffix})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}
