import { test } from "node:test";
import assert from "node:assert/strict";
import { generateToken, hashToken } from "./tokens.js";

test("generateToken produces unique, non-trivial tokens", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, "token should be high-entropy, not a short id");
});

test("hashToken is deterministic for the same input", () => {
  const token = generateToken();
  assert.equal(hashToken(token), hashToken(token));
});

test("hashToken produces different hashes for different tokens", () => {
  assert.notEqual(hashToken(generateToken()), hashToken(generateToken()));
});

test("hashToken never returns the raw token (DESIGN.md §3.2: never store the token itself)", () => {
  const token = generateToken();
  assert.notEqual(hashToken(token), token);
});
