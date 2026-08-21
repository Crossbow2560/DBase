import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "./password.js";

test("hashPassword produces a hash that verifyPassword accepts", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
});

test("verifyPassword rejects an incorrect password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("hashPassword never returns the plaintext", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.notEqual(hash, "correct horse battery staple");
});

test("isPasswordStrongEnough enforces the 8-character minimum (REQUIREMENTS.md §5.1)", () => {
  assert.equal(isPasswordStrongEnough("short1"), false);
  assert.equal(isPasswordStrongEnough("exactly8"), true);
  assert.equal(isPasswordStrongEnough("a longer password"), true);
});
