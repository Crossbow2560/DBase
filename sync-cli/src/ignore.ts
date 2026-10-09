import { readFileSync } from "node:fs";
import path from "node:path";

// Never synced in either direction: OS/editor litter, lock and temp files, and dbase-sync's own
// in-progress downloads.
export const DEFAULT_IGNORES = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "~$*",
  "*.tmp",
  "*.swp",
  ".~lock.*",
  ".dbaseignore",
  ".*.dbase-part",
];

export const TEMP_SUFFIX = ".dbase-part";

interface Rule {
  regex: RegExp;
  dirOnly: boolean;
  anchored: boolean;
  negate: boolean;
}

function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function parseRule(line: string): Rule | null {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#")) return null;
  const negate = pattern.startsWith("!");
  if (negate) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  return { regex: globToRegex(pattern), dirOnly, anchored, negate };
}

/**
 * A gitignore subset: `*`, `?`, `**`, trailing `/` for directories only, a `/` anywhere but the
 * end anchors the pattern to the sync root, and `!` re-includes. Paths are sync-root-relative
 * with forward slashes.
 */
export class IgnoreMatcher {
  private readonly rules: Rule[];

  constructor(lines: string[]) {
    this.rules = lines.map(parseRule).filter((r): r is Rule => r !== null);
  }

  static forRoot(rootDir: string): IgnoreMatcher {
    let custom: string[] = [];
    try {
      custom = readFileSync(path.join(rootDir, ".dbaseignore"), "utf8").split(/\r?\n/);
    } catch {
      // No .dbaseignore — defaults only.
    }
    return new IgnoreMatcher([...DEFAULT_IGNORES, ...custom]);
  }

  ignores(relPath: string, isDir: boolean): boolean {
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      const subject = rule.anchored ? relPath : base;
      if (rule.regex.test(subject)) ignored = !rule.negate;
    }
    return ignored;
  }
}
