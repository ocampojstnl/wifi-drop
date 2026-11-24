// Quick checks with no browser: the same-network check and the rooms. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { addressKind, isLocalPath } from "../public/lan.js";
import { roomFor, homeAddress } from "../lib/room.mjs";

const pair = (rtt = 0.004) => ({ state: "succeeded", nominated: true, currentRoundTripTime: rtt });
const cand = (candidateType, address) => ({ candidateType, address });

test("addresses: home network, carrier-shared, public", () => {
  for (const ip of ["192.168.1.20", "10.0.0.5", "172.20.1.1", "169.254.3.4", "127.0.0.1", "fd12::1", "fe80::1", "::1", "1f2e-aa.local"]) assert.equal(addressKind(ip), "private", ip);
  for (const ip of ["100.64.0.1", "100.127.255.1"]) assert.equal(addressKind(ip), "shared", ip);
  for (const ip of ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:db8::1"]) assert.equal(addressKind(ip), "public", ip);
  assert.equal(addressKind(""), "unknown");
});

test("same network: direct between home-network addresses", () => {
  assert.equal(isLocalPath({ pair: pair(), local: cand("host", "192.168.1.20"), remote: cand("host", "192.168.1.31") }), true);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("host", "abc.local") }), true);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("prflx", "192.168.1.31") }), true);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("host", "2001:db8:1:2::9"), localAddresses: ["2001:db8:1:2::5"] }), true);
});

test("not the same network: via the internet, a relay, carrier-shared, a different IPv6 home, or slow", () => {
  assert.equal(isLocalPath({ pair: pair(), local: cand("srflx"), remote: cand("host", "192.168.1.31") }), false);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("srflx", "203.0.113.9") }), false);
  assert.equal(isLocalPath({ pair: pair(), local: cand("relay"), remote: cand("host", "192.168.1.31") }), false);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("host", "100.70.1.2") }), false);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("prflx", "203.0.113.9") }), false);
  assert.equal(isLocalPath({ pair: pair(), local: cand("host"), remote: cand("host", "2001:db8:9:9::9"), localAddresses: ["2001:db8:1:2::5"] }), false);
  assert.equal(isLocalPath({ pair: pair(0.25), local: cand("host"), remote: cand("host", "192.168.1.31") }), false);
});

test("can't tell yet without stats", () => {
  assert.equal(isLocalPath({ pair: null, local: null, remote: null }), null);
});

test("rooms: one per home, IPv6 visits use the home's IPv4 address", () => {
  const S = "test-secret";
  assert.deepEqual(roomFor("203.0.113.7", S), roomFor("203.0.113.7", S));
  assert.notEqual(roomFor("203.0.113.7", S).room, roomFor("203.0.113.8", S).room);
  // Same IPv6 home (/64), different devices: same room.
  assert.equal(roomFor("2001:db8:1:2::5", S).room, roomFor("2001:db8:1:2:aaaa::9", S).room);
  // A phone over IPv6 and a PC over IPv4 in the same home meet, thanks to the IPv4 hint.
  assert.equal(roomFor("2001:db8:1:2::5", S, "203.0.113.7").room, roomFor("203.0.113.7", S).room);
  // The hint is ignored when the visit is already over IPv4, and when it isn't a public IPv4 address.
  assert.equal(homeAddress("203.0.113.7", "198.51.100.1"), "203.0.113.7");
  for (const bad of ["192.168.1.1", "100.64.0.1", "999.1.1.1", "nope", ""]) assert.equal(homeAddress("2001:db8::5", bad), "2001:db8::5", bad);
  // Testing at home: every home-network address is one room.
  assert.equal(roomFor("192.168.1.20", S).room, roomFor("10.0.0.3", S).room);
  // Without the secret, rooms differ from those with it.
  assert.notEqual(roomFor("203.0.113.7", S).room, roomFor("203.0.113.7", "other").room);
});
