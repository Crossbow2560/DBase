import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrustProxy, resolveCookieSecure } from "./env.js";

test("parseTrustProxy defaults to trusting loopback/private hops", () => {
  assert.equal(parseTrustProxy(undefined), "loopback,linklocal,uniquelocal");
  assert.equal(parseTrustProxy(""), "loopback,linklocal,uniquelocal");
});

test("parseTrustProxy understands booleans, hop counts and address lists", () => {
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("10.0.0.0/8,127.0.0.1"), "10.0.0.0/8,127.0.0.1");
});

test("resolveCookieSecure follows the public URL's scheme by default", () => {
  assert.equal(resolveCookieSecure(undefined, "https://files.example.com"), true);
  assert.equal(resolveCookieSecure(undefined, "HTTPS://files.example.com"), true);
  assert.equal(resolveCookieSecure(undefined, "http://192.168.1.20:3001"), false);
  assert.equal(resolveCookieSecure(undefined, "http://localhost:3001"), false);
});

test("COOKIE_SECURE overrides the default either way", () => {
  assert.equal(resolveCookieSecure("true", "http://localhost:3001"), true);
  assert.equal(resolveCookieSecure("false", "https://files.example.com"), false);
});
