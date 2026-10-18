import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decide, type BaseSide, type LocalSide, type PathInput, type RemoteSide } from "./reconcile.js";

const L = (hash: string | null = "h1"): LocalSide => ({ kind: "file", hash });
const R = (version = "v1", checksum: string | null = "h1", id = "id1"): RemoteSide => ({ kind: "file", id, version, checksum });
const E = (status: BaseSide["status"] = "synced", over: Partial<BaseSide> = {}): BaseSide => ({
  kind: "file",
  status,
  remoteId: "id1",
  baseVersion: "v1",
  baseHash: "h1",
  ...over,
});
const run = (over: Partial<PathInput>) =>
  decide({ local: null, remote: null, entry: null, canWrite: true, excluded: false, ...over }).type;

describe("files with no base", () => {
  test("both sides new: equal checksum adopts, anything else is a conflict", () => {
    assert.equal(run({ local: L("h1"), remote: R("v1", "h1") }), "adopt");
    assert.equal(run({ local: L("h1"), remote: R("v1", "h2") }), "conflict");
    assert.equal(run({ local: L("h1"), remote: R("v1", null) }), "conflict");
  });
  test("one side only", () => {
    assert.equal(run({ local: L() }), "upload_new");
    assert.equal(run({ local: L(), canWrite: false }), "read_only");
    assert.equal(run({ remote: R() }), "download");
    assert.equal(run({ remote: R(), excluded: true }), "noop");
  });
});

describe("synced files", () => {
  test("nothing changed (stat refresh only)", () => {
    assert.equal(run({ local: L(null), remote: R(), entry: E() }), "adopt");
    assert.equal(run({ local: L("h1"), remote: R(), entry: E() }), "adopt");
  });
  test("one side changed", () => {
    assert.equal(run({ local: L("h2"), remote: R(), entry: E() }), "upload_replace");
    assert.equal(run({ local: L("h2"), remote: R(), entry: E(), canWrite: false }), "read_only");
    assert.equal(run({ local: L(null), remote: R("v2", "h3"), entry: E() }), "download");
    // A different remote item now at this path counts as a remote change.
    assert.equal(run({ local: L(null), remote: R("v1", "h1", "id2"), entry: E() }), "download");
  });
  test("both changed: same content adopts, otherwise conflict", () => {
    assert.equal(run({ local: L("h9"), remote: R("v2", "h9"), entry: E() }), "adopt");
    assert.equal(run({ local: L("h8"), remote: R("v2", "h9"), entry: E() }), "conflict");
  });
  test("remote gone: the local copy is detached, never deleted", () => {
    assert.deepEqual(
      decide({ local: L(null), remote: null, entry: E(), canWrite: true, excluded: false }),
      { type: "mark_detached", edited: false },
    );
    assert.deepEqual(
      decide({ local: L("h2"), remote: null, entry: E(), canWrite: true, excluded: false }),
      { type: "mark_detached", edited: true },
    );
  });
  test("local gone: DBase is left alone, unless it was edited there", () => {
    assert.equal(run({ remote: R(), entry: E() }), "mark_local_removed");
    assert.equal(run({ remote: R("v2"), entry: E() }), "download");
  });
  test("gone from both sides", () => {
    assert.equal(run({ entry: E() }), "drop_entry");
  });
});

describe("locally removed files", () => {
  test("stay removed until the remote copy changes", () => {
    assert.equal(run({ remote: R(), entry: E("local_removed") }), "noop");
    assert.equal(run({ remote: R("v2"), entry: E("local_removed") }), "download");
  });
  test("re-created locally", () => {
    assert.equal(run({ local: L("h1"), remote: R("v1", "h1"), entry: E("local_removed") }), "adopt");
    assert.equal(run({ local: L("h5"), remote: R("v1", "h1"), entry: E("local_removed") }), "conflict");
    assert.equal(run({ local: L("h5"), entry: E("local_removed") }), "upload_new");
  });
  test("gone remotely too", () => {
    assert.equal(run({ entry: E("local_removed") }), "drop_entry");
  });
});

describe("detached files", () => {
  test("are never uploaded", () => {
    assert.equal(run({ local: L("h2"), entry: E("detached") }), "noop");
    assert.equal(run({ local: L(null), entry: E("detached") }), "noop");
  });
  test("relink when the item comes back in DBase", () => {
    assert.equal(run({ local: L("h1"), remote: R("v1", "h1"), entry: E("detached") }), "adopt");
    assert.equal(run({ local: L("h2"), remote: R("v1", "h1"), entry: E("detached") }), "conflict");
    assert.equal(run({ remote: R(), entry: E("detached") }), "download");
  });
  test("forgotten once the local copy is deleted too", () => {
    assert.equal(run({ entry: E("detached") }), "drop_entry");
  });
});

describe("folders", () => {
  const LF: LocalSide = { kind: "folder", hash: null };
  const RF: RemoteSide = { kind: "folder", id: "f1", version: null, checksum: null };
  const EF = (status: BaseSide["status"] = "synced", remoteId = "f1"): BaseSide => ({
    kind: "folder",
    status,
    remoteId,
    baseVersion: null,
    baseHash: null,
  });

  test("new on one side", () => {
    assert.equal(run({ local: LF }), "create_remote_folder");
    assert.equal(run({ local: LF, canWrite: false }), "read_only");
    assert.equal(run({ remote: RF }), "create_local_folder");
    assert.equal(run({ remote: RF, excluded: true }), "noop");
    assert.equal(run({ local: LF, remote: RF }), "adopt");
  });
  test("deleted on one side", () => {
    assert.equal(run({ remote: RF, entry: EF() }), "mark_local_removed");
    assert.equal(run({ local: LF, entry: EF() }), "mark_detached");
    assert.equal(run({ remote: RF, entry: EF("local_removed") }), "noop");
    assert.equal(run({ remote: RF, entry: EF("detached") }), "create_local_folder");
  });
  test("a file on one side and a folder on the other is left alone", () => {
    assert.equal(run({ local: L(), remote: RF }), "kind_mismatch");
  });
});
