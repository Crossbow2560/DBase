import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";

type Level = "info" | "warn" | "error";

let echo = false;

/** Also print log lines to the console (the `run` command). */
export function setLogEcho(on: boolean): void {
  echo = on;
}

/** Structured JSON lines to <config dir>/sync.log; never throws. */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(path.join(configDir(), "sync.log"), line + "\n");
  } catch {
    // Logging must never take the sync down.
  }
  if (echo) {
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    const out = `${new Date().toLocaleTimeString()} ${level === "info" ? "" : level.toUpperCase() + " "}${message}${extra ? " " + extra : ""}`;
    (level === "error" ? console.error : console.log)(out);
  }
}
