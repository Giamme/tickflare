/**
 * Changing a copy of a state without copying the state.
 *
 * `produce(base, recipe)` hands `recipe` a draft of `base` to change in
 * place, as a room's hooks change `this.state`, and returns the result.
 * `base` is not touched. Only the objects on the way to something that
 * changed are copied; everything else in the result is the same object as in
 * `base`, so the result can be compared with it by reference, part by part.
 *
 * It follows plain objects and arrays, which is what a state made of JSON
 * has. Anything else in it (a `Date`, a `Map`) is handed over as it is.
 */

/** One object or array of the base, and its copy once something in it has changed. */
interface Node {
  base: object;
  copy: object | undefined;
  parent: Node | undefined;
  /** Where it is in its parent. */
  key: string | undefined;
  proxy: object;
  /** Drafts handed out for what is inside, by key. */
  children: Map<string, Node>;
}

const nodes = new WeakMap<object, Node>();

/**
 * The state `recipe` makes of `base`, with `base` left as it was. If the
 * recipe changes nothing, the result is `base` itself.
 */
export function produce<T>(base: T, recipe: (draft: T) => void): T {
  if (!isDraftable(base)) {
    recipe(base);
    return base;
  }
  const root = draftOf(base, undefined, undefined);
  recipe(root.proxy as T);
  return (root.copy ?? root.base) as T;
}

function isDraftable(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function draftOf(base: object, parent: Node | undefined, key: string | undefined): Node {
  const node: Node = { base, copy: undefined, parent, key, proxy: undefined as unknown as object, children: new Map() };
  // The proxy's own target is an empty stand-in: nothing is read from it or written to it, and a
  // base that was frozen cannot get in the way.
  node.proxy = new Proxy(Array.isArray(base) ? [] : {}, handlerFor(node));
  nodes.set(node.proxy, node);
  return node;
}

/** What the draft holds now: its copy if it has one. */
const current = (node: Node): Record<string, unknown> => (node.copy ?? node.base) as Record<string, unknown>;

/** Gives the node a copy to write to, and puts that copy in its parent's, all the way up. */
function writable(node: Node): Record<string, unknown> {
  if (node.copy === undefined) {
    node.copy = Array.isArray(node.base) ? node.base.slice() : { ...node.base };
    if (node.parent && node.key !== undefined) writable(node.parent)[node.key] = node.copy;
  }
  return node.copy as Record<string, unknown>;
}

/** A value on its way into a draft, with any drafts in it replaced by what they hold. */
function settled(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const node = nodes.get(value);
  if (node) return current(node);
  if (!isDraftable(value)) return value;
  // A new object or array: it is the recipe's own, so drafts inside it are replaced in place.
  const holder = value as Record<string, unknown>;
  for (const key of Object.keys(holder)) {
    const inner = holder[key];
    if (typeof inner === "object" && inner !== null) {
      const plain = settled(inner);
      if (plain !== inner) holder[key] = plain;
    }
  }
  return value;
}

function handlerFor(node: Node): ProxyHandler<object> {
  return {
    get(_target, key, receiver) {
      const source = current(node);
      if (typeof key === "symbol") return Reflect.get(source, key, receiver);
      const value = source[key];
      if (!isDraftable(value)) {
        // An array's own methods run on the draft, so that what they write is followed.
        return typeof value === "function" ? Reflect.get(source, key, receiver) : value;
      }
      let child = node.children.get(key);
      if (!child || current(child) !== value) {
        child = draftOf(value, node, key);
        node.children.set(key, child);
      }
      return child.proxy;
    },
    set(_target, key, value) {
      if (typeof key === "symbol") return false;
      const next = settled(value);
      const source = current(node);
      // Writing what is there already is not a change, and must not cost a copy.
      if (Object.prototype.hasOwnProperty.call(source, key) && Object.is(source[key], next)) return true;
      writable(node)[key] = next;
      node.children.delete(key);
      return true;
    },
    deleteProperty(_target, key) {
      if (typeof key === "symbol") return false;
      if (!Object.prototype.hasOwnProperty.call(current(node), key)) return true;
      delete writable(node)[key];
      node.children.delete(key);
      return true;
    },
    defineProperty(_target, key, descriptor) {
      if (typeof key === "symbol" || !("value" in descriptor)) return false;
      writable(node)[key] = settled(descriptor.value);
      node.children.delete(key);
      return true;
    },
    has: (_target, key) => Reflect.has(current(node), key),
    ownKeys: () => Reflect.ownKeys(current(node)),
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(node), key);
      // What the draft holds is not the proxy's own target, so nothing in it may claim to be fixed
      // there, except an array's length, which is.
      if (descriptor && !(Array.isArray(node.base) && key === "length")) descriptor.configurable = true;
      return descriptor;
    },
  };
}
