import assert from "node:assert/strict";
import test from "node:test";
import { assertPlainDataGraph, hasExactDataKeys, isDenseArrayOf, isPlainDataRecord } from "./validation.ts";

test("wire record validation rejects Proxies and accessors without invoking them", () => {
  let trapCount = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      trapCount += 1;
      return Object.prototype;
    },
  });
  assert.equal(isPlainDataRecord(proxy), false);
  assert.equal(trapCount, 0);
  let invoked = false;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      invoked = true;
      return "unsafe";
    },
  });
  assert.equal(isPlainDataRecord(accessor), false);
  assert.equal(invoked, false);
});

test("exact data-key validation rejects folded, inherited, symbol, and accessor fields", () => {
  assert.equal(hasExactDataKeys({ type: "registered" }, ["type"]), true);
  assert.equal(hasExactDataKeys({ type: "registered", Boss: {} }, ["type"]), false);
  assert.equal(hasExactDataKeys(Object.create({ type: "registered" }), ["type"]), false);
  assert.equal(hasExactDataKeys({ type: "registered", [Symbol("boss")]: true }, ["type"]), false);
  assert.equal(hasExactDataKeys(Object.defineProperty({}, "type", { get: () => "registered", enumerable: true }), ["type"]), false);
});

test("nested authoritative preflight rejects a Proxy with zero traps", () => {
  let trapCount = 0;
  const nested = new Proxy({ value: "secret" }, {
    getPrototypeOf() {
      trapCount += 1;
      throw new Error("must not run");
    },
    ownKeys() {
      trapCount += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => assertPlainDataGraph({ nested }), /Proxy/);
  const callableProxy = new Proxy(() => undefined, {
    getPrototypeOf() {
      trapCount += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => assertPlainDataGraph({ callableProxy }), /Proxy/);
  assert.equal(trapCount, 0);
});

test("wire array validation rejects every non-exact array shape", () => {
  const stringEntry = (entry: unknown): entry is string => typeof entry === "string";
  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.equal(isDenseArrayOf(sparse, stringEntry), false);

  const inherited = ["value"];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, { 0: { value: "inherited", enumerable: true } }));
  assert.equal(isDenseArrayOf(inherited, stringEntry), false);

  const accessor = ["value"];
  Object.defineProperty(accessor, "0", { get: () => "value", enumerable: true });
  assert.equal(isDenseArrayOf(accessor, stringEntry), false);

  const symbol = ["value"];
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  assert.equal(isDenseArrayOf(symbol, stringEntry), false);

  const extra = ["value"] as string[] & { extra?: boolean };
  extra.extra = true;
  assert.equal(isDenseArrayOf(extra, stringEntry), false);

  let trapCount = 0;
  const proxy = new Proxy(["value"], {
    getPrototypeOf() {
      trapCount += 1;
      return Array.prototype;
    },
  });
  assert.equal(isDenseArrayOf(proxy, stringEntry), false);
  assert.equal(trapCount, 0);
  assert.equal(isDenseArrayOf(["value"], stringEntry), true);
});
