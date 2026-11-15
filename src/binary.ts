/**
 * Patches in binary, for clients that ask for them.
 *
 * A browser's WebSocket is compressed by Cloudflare, which makes JSON patches
 * small on the wire. A client that does not offer compression, as many game
 * engines' do not, is sent the JSON as it is: for those, this format is about
 * a third of the size. It carries exactly what a `patch` frame carries, and
 * nothing else is sent in binary.
 *
 * The layout is in the protocol reference. In short: a frame is a WebSocket
 * binary message; whole numbers are varints; a name used as a key is sent
 * once, and by its number after that.
 */
import type { PatchFrame } from "./protocol.js";
import type { ArrayPatch, Patch } from "./patch.js";

/** The value of the `patches` query parameter that asks for this format, and its first byte. */
export const BINARY_PATCHES = "b1";
const MAGIC = 0xb1;

const FLAG_FROM = 1;
const FLAG_SHOWS = 2;
const FLAG_FORGET = 4;

const enum Tag {
  Null = 0,
  False = 1,
  True = 2,
  /** A whole number, zero or more: a varint. */
  Int = 3,
  /** A whole number below zero: a varint of its size. */
  NegativeInt = 4,
  /** A number with one decimal place: a varint of ten times it. */
  Tenths = 5,
  NegativeTenths = 6,
  /** A number with two decimal places: a varint of a hundred times it. */
  Hundredths = 7,
  NegativeHundredths = 8,
  /** Any other number: eight bytes, big-endian. */
  Float = 9,
  String = 10,
  Array = 11,
  Object = 12,
  /** In a patch only: the key is deleted. */
  Delete = 13,
  /** In a patch only: a patch of what the key holds follows. */
  Nested = 14,
  /** In a patch only: the key holds an array, and what changed in it follows. */
  Elements = 15,
}

/** Keys longer than this are sent in full every time: a name is short, and an id that long is rare. */
const LONGEST_KEY = 64;
/** The most keys a table holds before it is started again. */
export const MOST_KEYS = 8192;
/** Numbers up to this size are tried as tenths and hundredths. */
const DECIMAL_LIMIT = 1e12;

const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The buffer every writer starts in. Writing is done one writer at a time, and `done()` copies
 * what was written out, so they can share it: a room sending a thousand players a frame each
 * makes a thousand small copies a tick, not a thousand buffers to grow and throw away.
 */
let scratch = new Uint8Array(4096);
let scratchView = new DataView(scratch.buffer);
/** A buffer grown past this is not kept for the next writer. */
const LARGEST_SCRATCH = 64 * 1024;

/** Bytes, written one after another into a buffer that grows. */
class Writer {
  #bytes = scratch;
  #view = scratchView;
  length = 0;

  #room(more: number): void {
    if (this.length + more <= this.#bytes.length) return;
    const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.length + more));
    grown.set(this.#bytes.subarray(0, this.length));
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
    if (grown.length <= LARGEST_SCRATCH) {
      scratch = grown;
      scratchView = this.#view;
    }
  }

  byte(value: number): void {
    this.#room(1);
    this.#bytes[this.length++] = value;
  }

  /** A whole number from 0 to 2^53, seven bits to a byte, least first; every byte but the last has its top bit set. */
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a whole number from 0 up: ${value}`);
    this.#room(8);
    while (value >= 0x80) {
      this.#bytes[this.length++] = (value % 0x80) | 0x80;
      value = Math.floor(value / 0x80);
    }
    this.#bytes[this.length++] = value;
  }

  float(value: number): void {
    this.#room(8);
    this.#view.setFloat64(this.length, value);
    this.length += 8;
  }

  bytes(value: Uint8Array): void {
    this.#room(value.length);
    this.#bytes.set(value, this.length);
    this.length += value.length;
  }

  /** A string: its length in bytes as a varint, then its UTF-8. */
  string(value: string): void {
    const encoded = utf8.encode(value);
    this.varint(encoded.length);
    this.bytes(encoded);
  }

  done(): Uint8Array {
    return this.#bytes.slice(0, this.length);
  }
}

/**
 * The names a room has sent as keys, each with a number: its place in the
 * order they were first sent. One table serves every socket of the room; a
 * socket is told the names it has not been told yet at the start of its
 * next frame.
 */
export class KeyTable {
  #numbers = new Map<string, number>();
  /** Every name, as it is written in a definition: length and UTF-8. */
  #definitions: Uint8Array[] = [];
  /** Goes up each time the table is started again: a socket that knows another has to forget its keys. */
  generation = 0;

  get size(): number {
    return this.#definitions.length;
  }

  /** Starts the table again if it is full. Between frames only: a frame's numbers are of one table. */
  renew(): void {
    if (this.#definitions.length < MOST_KEYS) return;
    this.#numbers.clear();
    this.#definitions = [];
    this.generation += 1;
  }

  /** Writes a key: its number, or the name itself if it is not in the table and cannot be put there. */
  write(to: Writer, key: string): void {
    let number = this.#numbers.get(key);
    if (number === undefined && key.length <= LONGEST_KEY && this.#definitions.length < MOST_KEYS) {
      number = this.#definitions.length;
      this.#numbers.set(key, number);
      // At most 64 characters, so at most 192 bytes: the length fits the two bytes kept for it.
      const name = utf8.encode(key);
      const definition = new Uint8Array(name.length + (name.length < 0x80 ? 1 : 2));
      if (name.length < 0x80) definition[0] = name.length;
      else definition.set([(name.length % 0x80) | 0x80, name.length >> 7]);
      definition.set(name, definition.length - name.length);
      this.#definitions.push(definition);
    }
    if (number === undefined) {
      to.byte(0);
      to.string(key);
    } else {
      to.varint(number + 1);
    }
  }

  /** Writes the definitions of the keys numbered `from` and up: how many, then each. */
  define(to: Writer, from: number): void {
    to.varint(this.#definitions.length - from);
    for (let number = from; number < this.#definitions.length; number++) to.bytes(this.#definitions[number]!);
  }
}

function writeValue(to: Writer, keys: KeyTable, value: unknown): void {
  switch (typeof value) {
    case "boolean":
      return to.byte(value ? Tag.True : Tag.False);
    case "string":
      to.byte(Tag.String);
      return to.string(value);
    case "number":
      return writeNumber(to, value);
    case "object": {
      if (value === null) return to.byte(Tag.Null);
      if (Array.isArray(value)) {
        to.byte(Tag.Array);
        to.varint(value.length);
        // As in JSON: what cannot be said is null in an array.
        for (const item of value) writeValue(to, keys, item === undefined ? null : item);
        return;
      }
      const record = value as Record<string, unknown>;
      const names = Object.keys(record).filter((name) => record[name] !== undefined);
      to.byte(Tag.Object);
      to.varint(names.length);
      for (const name of names) {
        keys.write(to, name);
        writeValue(to, keys, record[name]);
      }
      return;
    }
    default:
      throw new TypeError(`cannot be sent: ${typeof value}`);
  }
}

function writeNumber(to: Writer, value: number): void {
  if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
    to.byte(value < 0 ? Tag.NegativeInt : Tag.Int);
    return to.varint(Math.abs(value));
  }
  const size = Math.abs(value);
  // Not minus zero: its sign would be lost.
  if (size < DECIMAL_LIMIT && size !== 0) {
    // Sent as a whole number of tenths or hundredths only if dividing gives the very same number back.
    const tenths = Math.round(size * 10);
    if (tenths / 10 === size) {
      to.byte(value < 0 ? Tag.NegativeTenths : Tag.Tenths);
      return to.varint(tenths);
    }
    const hundredths = Math.round(size * 100);
    if (hundredths / 100 === size) {
      to.byte(value < 0 ? Tag.NegativeHundredths : Tag.Hundredths);
      return to.varint(hundredths);
    }
  }
  if (!Number.isFinite(value)) throw new TypeError(`cannot be sent: ${value}`);
  to.byte(Tag.Float);
  to.float(value);
}

function writePatch(to: Writer, keys: KeyTable, patch: Patch): void {
  const names = Object.keys(patch);
  to.varint(names.length);
  for (const name of names) {
    keys.write(to, name);
    writeChange(to, keys, patch[name]!);
  }
}

/** What to do with one key of an object or one element of an array. */
function writeChange(to: Writer, keys: KeyTable, change: Patch[string]): void {
  if (change === 0) return to.byte(Tag.Delete);
  if (!Array.isArray(change)) {
    to.byte(Tag.Nested);
    return writePatch(to, keys, change);
  }
  if (change.length !== 2) return writeValue(to, keys, change[0] === undefined ? null : change[0]);
  // An array's elements: its new length, how many changed, and each by its index.
  const [changes, length] = change;
  const indexes = Object.keys(changes);
  to.byte(Tag.Elements);
  to.varint(length);
  to.varint(indexes.length);
  for (const index of indexes) {
    to.varint(Number(index));
    writeChange(to, keys, changes[index]!);
  }
}

/** A patch as bytes, without the frame around it. Keys it has not seen go into `keys`. */
export function encodePatch(patch: Patch, keys: KeyTable): Uint8Array {
  const to = new Writer();
  writePatch(to, keys, patch);
  return to.done();
}

/**
 * The frame around an encoded patch, for a socket that knows the first
 * `known` keys of the table, or none of them when `forget` is set.
 */
export function encodePatchFrame(
  head: { seq: number; tick: number; from?: number | undefined; c?: number | undefined },
  keys: KeyTable,
  known: number,
  forget: boolean,
  patch: Uint8Array,
): Uint8Array {
  const to = new Writer();
  to.byte(MAGIC);
  to.byte((head.from === undefined ? 0 : FLAG_FROM) | (head.c === undefined ? 0 : FLAG_SHOWS) | (forget ? FLAG_FORGET : 0));
  to.varint(head.seq);
  to.varint(head.tick);
  if (head.from !== undefined) to.varint(head.from);
  if (head.c !== undefined) to.varint(head.c);
  keys.define(to, forget ? 0 : known);
  to.bytes(patch);
  return to.done();
}

/** Bytes, read one after another. */
class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte(): number {
    if (this.at >= this.#bytes.length) throw new RangeError("the frame ends too soon");
    return this.#bytes[this.at++]!;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
      if (scale > Number.MAX_SAFE_INTEGER) throw new RangeError("a number in the frame is too long");
    }
    if (!Number.isSafeInteger(value)) throw new RangeError("a number in the frame is too large");
    return value;
  }

  float(): number {
    if (this.at + 8 > this.#bytes.length) throw new RangeError("the frame ends too soon");
    const value = this.#view.getFloat64(this.at);
    this.at += 8;
    return value;
  }

  string(): string {
    const length = this.varint();
    if (this.at + length > this.#bytes.length) throw new RangeError("the frame ends too soon");
    const value = text.decode(this.#bytes.subarray(this.at, this.at + length));
    this.at += length;
    return value;
  }

  get done(): boolean {
    return this.at === this.#bytes.length;
  }
}

function readKey(from: Reader, keys: readonly string[]): string {
  const number = from.varint();
  if (number === 0) return from.string();
  const key = keys[number - 1];
  if (key === undefined) throw new RangeError(`the frame uses key ${number - 1}, which was never defined`);
  return key;
}

function readValue(from: Reader, keys: readonly string[], tag = from.byte()): unknown {
  switch (tag) {
    case Tag.Null:
      return null;
    case Tag.False:
      return false;
    case Tag.True:
      return true;
    case Tag.Int:
      return from.varint();
    case Tag.NegativeInt:
      return -from.varint();
    case Tag.Tenths:
      return from.varint() / 10;
    case Tag.NegativeTenths:
      return -(from.varint() / 10);
    case Tag.Hundredths:
      return from.varint() / 100;
    case Tag.NegativeHundredths:
      return -(from.varint() / 100);
    case Tag.Float:
      return from.float();
    case Tag.String:
      return from.string();
    case Tag.Array: {
      const items: unknown[] = [];
      for (let left = from.varint(); left > 0; left--) items.push(readValue(from, keys));
      return items;
    }
    case Tag.Object: {
      const record: Record<string, unknown> = {};
      for (let left = from.varint(); left > 0; left--) {
        const key = readKey(from, keys);
        define(record, key, readValue(from, keys));
      }
      return record;
    }
    default:
      throw new RangeError(`the frame has a value of a kind this client does not know: ${tag}`);
  }
}

/** Sets a key as JSON.parse does: as the object's own, whatever its name. */
function define(record: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
  else record[key] = value;
}

function readPatch(from: Reader, keys: readonly string[]): Patch {
  const patch: Patch = {};
  for (let left = from.varint(); left > 0; left--) {
    const key = readKey(from, keys);
    define(patch as Record<string, unknown>, key, readChange(from, keys));
  }
  return patch;
}

function readChange(from: Reader, keys: readonly string[]): Patch[string] {
  const tag = from.byte();
  if (tag === Tag.Delete) return 0;
  if (tag === Tag.Nested) return readPatch(from, keys);
  if (tag !== Tag.Elements) return [readValue(from, keys, tag)];
  const length = from.varint();
  const changes: ArrayPatch[0] = {};
  for (let left = from.varint(); left > 0; left--) {
    const index = from.varint();
    const change = readChange(from, keys);
    if (change === 0) throw new RangeError("the frame deletes an element of an array, which nothing does");
    changes[index] = change;
  }
  return [changes, length];
}

/**
 * Reads a binary `patch` frame into the same object its JSON form would
 * parse to. `keys` is the table of the connection the frame came on: start
 * each connection with an empty array and hand in the same one every time.
 * The frame's key definitions are added to it, after it has been emptied if
 * the frame says to forget.
 *
 * Throws if the bytes are not a frame of this format. The connection's
 * table can then no longer be trusted: reconnect.
 */
export function decodePatchFrame(bytes: Uint8Array, keys: string[]): PatchFrame {
  const from = new Reader(bytes);
  if (from.byte() !== MAGIC) throw new RangeError("not a binary patch frame");
  const flags = from.byte();
  // The fields in the order the JSON frame has them.
  const frame = { t: "patch", seq: from.varint(), tick: from.varint() } as PatchFrame;
  if (flags & FLAG_FROM) frame.from = from.varint();
  if (flags & FLAG_SHOWS) frame.c = from.varint();
  if (flags & FLAG_FORGET) keys.length = 0;
  for (let left = from.varint(); left > 0; left--) keys.push(from.string());
  frame.p = readPatch(from, keys);
  if (!from.done) throw new RangeError("the frame is longer than what it holds");
  return frame;
}
