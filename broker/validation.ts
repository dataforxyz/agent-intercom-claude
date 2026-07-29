import { types as nodeUtilTypes } from "node:util";

/** Reject accessors, inherited records, and Proxies before reading wire data. */
export function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || nodeUtilTypes.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  try {
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, "value");
    });
  } catch {
    return false;
  }
}

/** Require a plain record with exactly the declared own data properties. */
export function hasExactDataKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainDataRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return keys.length >= required.length
    && keys.every((key) => typeof key === "string" && allowed.has(key))
    && required.every((key) => Object.hasOwn(value, key));
}

/**
 * Preflight an authoritative nested graph without invoking Proxy traps or
 * accessors. Core parsers may run only after this adapter-owned check passes.
 */
export function assertPlainDataGraph(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  if (nodeUtilTypes.isProxy(value)) {
    throw new Error(`${path} must not contain a Proxy`);
  }
  if (seen.has(value)) {
    throw new Error(`${path} must not contain a cycle or repeated object reference`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${path} must use the exact Array prototype`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value")) {
      throw new Error(`${path}.length must be an own data property`);
    }
    const length = lengthDescriptor.value;
    const descriptors = new Map<number, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string") throw new Error(`${path} must not contain symbol properties`);
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
        throw new Error(`${path} must not contain non-index properties`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${path}[${index}] must be an enumerable own data property`);
      }
      descriptors.set(index, descriptor);
    }
    if (descriptors.size !== length) throw new Error(`${path} must be dense`);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors.get(index);
      if (descriptor === undefined) throw new Error(`${path} must be dense`);
      assertPlainDataGraph(descriptor.value, `${path}[${index}]`, seen);
    }
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be a plain data object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${path} must not contain symbol properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${path}.${key} must be an enumerable own data property`);
    }
    assertPlainDataGraph(descriptor.value, `${path}.${key}`, seen);
  }
}

/** Array.prototype.every skips holes; wire arrays must instead be exact and dense. */
export function isDenseArrayOf<T>(
  value: unknown,
  predicate: (entry: unknown, index: number) => entry is T,
): value is T[] {
  if (
    typeof value !== "object"
    || value === null
    || nodeUtilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) return false;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value")) return false;
    const length = lengthDescriptor.value;
    const entries = new Map<number, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string") return false;
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return false;
      entries.set(index, descriptor.value);
    }
    if (entries.size !== length) return false;
    for (let index = 0; index < length; index += 1) {
      if (!predicate(entries.get(index), index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
