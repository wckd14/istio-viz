import { test } from "node:test";
import assert from "node:assert/strict";
import { expandHost, hostMatches, intersectHosts, intersectPattern, parseGatewayHost } from "../src/hosts.js";

test("hostMatches: exact, wildcard, star", () => {
  assert.equal(hostMatches("shop.example.com", "shop.example.com"), true);
  assert.equal(hostMatches("shop.example.com", "other.example.com"), false);
  assert.equal(hostMatches("*", "anything.at.all"), true);
  assert.equal(hostMatches("*.example.com", "shop.example.com"), true);
  assert.equal(hostMatches("*.example.com", "a.b.example.com"), true);
  assert.equal(hostMatches("*.example.com", "example.com"), false);
  assert.equal(hostMatches("*.example.com", "shop.example.org"), false);
});

test("intersectPattern: wildcard semantics", () => {
  assert.equal(intersectPattern("*", "shop.example.com"), "shop.example.com");
  assert.equal(intersectPattern("*.example.com", "shop.example.com"), "shop.example.com");
  assert.equal(intersectPattern("shop.example.com", "*.example.com"), "shop.example.com");
  assert.equal(intersectPattern("*.shop.example.com", "*.example.com"), "*.shop.example.com");
  assert.equal(intersectPattern("*.example.com", "*.example.org"), null);
  assert.equal(intersectPattern("a.example.com", "b.example.com"), null);
});

test("intersectHosts dedupes and preserves order", () => {
  assert.deepEqual(intersectHosts(["shop.example.com", "*.example.com"], ["*"]), [
    "shop.example.com",
    "*.example.com",
  ]);
  assert.deepEqual(intersectHosts(["other.org"], ["*.example.com"]), []);
});

test("expandHost: short names get FQDN, wildcards and dotted hosts untouched", () => {
  assert.equal(expandHost("reviews", "prod"), "reviews.prod.svc.cluster.local");
  assert.equal(expandHost("reviews.prod.svc.cluster.local", "other"), "reviews.prod.svc.cluster.local");
  assert.equal(expandHost("api.example.com", "prod"), "api.example.com");
  assert.equal(expandHost("*.example.com", "prod"), "*.example.com");
});

test("parseGatewayHost: namespace qualifiers", () => {
  assert.deepEqual(parseGatewayHost("shop.example.com", "gwns"), { host: "shop.example.com" });
  assert.deepEqual(parseGatewayHost("*/shop.example.com", "gwns"), { host: "shop.example.com" });
  assert.deepEqual(parseGatewayHost("./shop.example.com", "gwns"), { namespace: "gwns", host: "shop.example.com" });
  assert.deepEqual(parseGatewayHost("prod/shop.example.com", "gwns"), { namespace: "prod", host: "shop.example.com" });
});
