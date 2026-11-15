// Where a profile's time went: the functions with the most time of their own, and the most time
// with what they call, from a pprof file as Cloudflare's profiling API returns it (gzip or not).
//
//   node bench/pprof-top.mjs profile.pb.gz [how many, 25 by default]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [file, many = "25"] = process.argv.slice(2);
if (!file) throw new Error("usage: node bench/pprof-top.mjs <profile> [how many]");
let bytes = readFileSync(file);
if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);

/** The fields of one protobuf message: field number to the values found, in order. */
function fields(buffer) {
  const found = new Map();
  let at = 0;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buffer[at++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7n;
    }
  };
  while (at < buffer.length) {
    const key = Number(varint());
    const number = key >> 3;
    const type = key & 7;
    let value;
    if (type === 0) value = varint();
    else if (type === 2) {
      const length = Number(varint());
      value = buffer.subarray(at, at + length);
      at += length;
    } else if (type === 1) {
      value = buffer.readBigUInt64LE(at);
      at += 8;
    } else if (type === 5) {
      value = BigInt(buffer.readUInt32LE(at));
      at += 4;
    } else throw new Error(`wire type ${type} is not expected in a profile`);
    if (!found.has(number)) found.set(number, []);
    found.get(number).push(value);
  }
  return found;
}

/** A repeated number field, packed or not. */
function numbers(found, number) {
  const out = [];
  for (const value of found.get(number) ?? []) {
    if (typeof value === "bigint") {
      out.push(value);
      continue;
    }
    let at = 0;
    while (at < value.length) {
      let item = 0n;
      let shift = 0n;
      for (;;) {
        const byte = value[at++];
        item |= BigInt(byte & 0x7f) << shift;
        if (byte < 0x80) break;
        shift += 7n;
      }
      out.push(item);
    }
  }
  return out;
}
const one = (found, number) => (found.get(number)?.[0] ?? 0n);

const profile = fields(bytes);
const strings = (profile.get(6) ?? []).map((value) => value.toString("utf8"));
const types = (profile.get(1) ?? []).map((value) => {
  const type = fields(value);
  return `${strings[Number(one(type, 1))]}/${strings[Number(one(type, 2))]}`;
});
// The value to add up: CPU time if the profile has it, else the last kind it has.
let pick = types.findIndex((type) => type.includes("nanoseconds") || type.startsWith("cpu"));
if (pick < 0) pick = types.length - 1;

const functions = new Map();
for (const value of profile.get(5) ?? []) {
  const fn = fields(value);
  const name = strings[Number(one(fn, 2))] || "(anonymous)";
  const filename = strings[Number(one(fn, 4))] ?? "";
  functions.set(one(fn, 1), { name, filename });
}
/** Each location's functions, innermost first. */
const locations = new Map();
for (const value of profile.get(4) ?? []) {
  const location = fields(value);
  const lines = (location.get(4) ?? []).map((line) => {
    const fieldsOf = fields(line);
    return { fn: one(fieldsOf, 1), line: Number(one(fieldsOf, 2)) };
  });
  locations.set(one(location, 1), lines);
}

const own = new Map();
const inclusive = new Map();
let total = 0;
const label = ({ fn, line }) => {
  const known = functions.get(fn) ?? { name: "?", filename: "" };
  const where = known.filename ? ` ${known.filename.split("/").slice(-2).join("/")}:${line}` : "";
  return `${known.name}${where}`;
};
for (const value of profile.get(2) ?? []) {
  const sample = fields(value);
  const stack = numbers(sample, 1).flatMap((id) => locations.get(id) ?? []);
  const amount = Number(numbers(sample, 2)[pick] ?? 0n);
  total += amount;
  if (stack.length === 0) continue;
  const leaf = label(stack[0]);
  own.set(leaf, (own.get(leaf) ?? 0) + amount);
  const seen = new Set();
  for (const frame of stack) {
    const key = label(frame).replace(/:\d+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    inclusive.set(key, (inclusive.get(key) ?? 0) + amount);
  }
}

const unit = types[pick] ?? "";
const scale = unit.includes("nanoseconds") ? 1e6 : 1;
const show = (amount) => (scale === 1 ? String(amount) : `${(amount / scale).toFixed(0)} ms`);
const top = (map) =>
  [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(many))
    .map(([name, amount]) => `${((100 * amount) / (total || 1)).toFixed(1).padStart(5)}%  ${show(amount).padStart(8)}  ${name}`)
    .join("\n");
const seconds = Number(one(profile, 10)) / 1e9;
console.log(`${file}: ${types.join(", ")}; ${unit} ${show(total)} in all${seconds ? `, over ${seconds.toFixed(1)} s` : ""}`);
console.log(`Own time:\n${top(own)}`);
console.log(`With what they call:\n${top(inclusive)}`);
