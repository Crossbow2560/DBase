import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where dbase-sync keeps its credentials, state database and log:
 *   Linux    $XDG_CONFIG_HOME/dbase-sync, else ~/.config/dbase-sync
 *   Windows  %APPDATA%\dbase-sync
 * DBASE_SYNC_HOME overrides both (tests, or running several independent instances).
 */
export function configDir(): string {
  if (process.env.DBASE_SYNC_HOME) return process.env.DBASE_SYNC_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "dbase-sync");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "dbase-sync");
}

export interface Credentials {
  server: string;
  token: string;
  tokenName: string;
  email: string;
}

const credentialsPath = () => path.join(configDir(), "credentials.json");

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** Written atomically and readable only by the current user — it holds a bearer token. */
export function saveCredentials(credentials: Credentials | null): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const target = credentialsPath();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(credentials ?? {}, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}
