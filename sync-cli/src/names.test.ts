import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { collisionKey, conflictedCopyName, normalizeName, unsyncableReason } from "./names.js";
import { IgnoreMatcher, DEFAULT_IGNORES } from "./ignore.js";

describe("names", () => {
  test("NFC normalization", () => {
    assert.equal(normalizeName("é"), "é");
  });

  test("Linux accepts what Windows rejects", () => {
    for (const name of ["a:b.txt", "CON", "nul.txt", "trailing.", "trailing ", 'q"uote', "pipe|"]) {
      assert.equal(unsyncableReason(name, "linux"), null, name);
      assert.notEqual(unsyncableReason(name, "win32"), null, name);
    }
    assert.equal(unsyncableReason("console.txt", "win32"), null);
    assert.equal(unsyncableReason("COM1.log", "win32"), "a reserved device name on Windows");
  });

  test("both platforms reject over-long names", () => {
    assert.notEqual(unsyncableReason("x".repeat(256), "linux"), null);
    assert.equal(unsyncableReason("x".repeat(255), "linux"), null);
  });

  test("case-only collisions matter on Windows only", () => {
    assert.equal(collisionKey("Report.PDF", "win32"), collisionKey("report.pdf", "win32"));
    assert.notEqual(collisionKey("Report.PDF", "linux"), collisionKey("report.pdf", "linux"));
  });

  test("conflicted copy names keep the extension and never collide", () => {
    const date = new Date("2026-10-09T12:00:00Z");
    const taken = new Set(["notes (conflicted copy laptop 2026-10-09).txt"]);
    assert.equal(
      conflictedCopyName("notes.txt", "laptop", date, (n) => taken.has(n)),
      "notes (conflicted copy laptop 2026-10-09 2).txt",
    );
    assert.equal(conflictedCopyName("Makefile", "pc", date, () => false), "Makefile (conflicted copy pc 2026-10-09)");
    assert.equal(conflictedCopyName(".env", "pc", date, () => false), ".env (conflicted copy pc 2026-10-09)");
  });
});

describe("ignore rules", () => {
  const m = new IgnoreMatcher([...DEFAULT_IGNORES, "build/", "/top-only.txt", "*.log", "!keep.log", "docs/**/*.bak"]);

  test("defaults", () => {
    assert.ok(m.ignores("a/.DS_Store", false));
    assert.ok(m.ignores("~$report.docx", false));
    assert.ok(m.ignores("dir/.photo.jpg.abc123.dbase-part", false));
    assert.ok(!m.ignores("report.docx", false));
  });

  test("directory-only, anchored, negated and ** patterns", () => {
    assert.ok(m.ignores("x/build", true));
    assert.ok(!m.ignores("x/build", false));
    assert.ok(m.ignores("top-only.txt", false));
    assert.ok(!m.ignores("sub/top-only.txt", false));
    assert.ok(m.ignores("deep/a.log", false));
    assert.ok(!m.ignores("deep/keep.log", false));
    assert.ok(m.ignores("docs/a/b/c.bak", false));
    assert.ok(!m.ignores("other/c.bak", false));
  });
});
