#!/usr/bin/env node
// Which rooms Cloudflare billed you for, and for how long, from its analytics.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node tools/rooms-report.mjs --worker my-game --since 24h
//
// The token needs to read account analytics and Workers settings ("Account Analytics: Read" and
// "Workers Scripts: Read"). It is read from the environment only, never from an argument, so
// that it does not end up in your shell's history.
//
// Options:
//   --worker <name>       the Worker whose rooms to report on (its Durable Object namespaces)
//   --namespace <id>      a namespace by id instead, for a Worker that is gone; may repeat
//   --since <time>        how far back: 30m, 6h, 7d, or a date such as 2026-11-01T00:00:00Z. Default 24h.
//   --top <n>             how many rooms to list, the most expensive first. Default 30.
//   --json                print JSON instead of a table
//
// Analytics lag by some minutes, and are kept for about a month.

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const all = (name) => args.flatMap((arg, at) => (arg === `--${name}` ? [args[at + 1]] : []));

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const worker = option("worker");
const top = Number(option("top") ?? 30);
const json = args.includes("--json");
if (!token || !account) fail("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
if (!worker && all("namespace").length === 0) fail("Say which rooms: --worker <name>, or --namespace <id>.");

/** Workers Paid list prices, November 2026, before what the plan includes each month. */
const PRICE = { perGbSecond: 12.5 / 1e6, perRowWritten: 1 / 1e6, perRequest: 0.15 / 1e6, messagesPerRequest: 20 };

function fail(message) {
  console.error(message);
  process.exit(2);
}

function since(text = "24h") {
  const relative = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(text);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]];
    return new Date(Date.now() - Number(relative[1]) * unit);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) fail(`--since: not a time: ${text}`);
  return date;
}

async function api(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) fail(`Cloudflare refused ${path.split("?")[0]} (${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
  return body.result;
}

async function graphql(query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) {
    fail(`Cloudflare's analytics refused (${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`);
  }
  return body.data.viewer.accounts[0];
}

/** The Worker's Durable Object namespaces, by id, with their class names. */
async function namespaces() {
  const known = new Map(all("namespace").map((id) => [id, id]));
  if (!worker) return known;
  for (let page = 1; ; page++) {
    const result = await api(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100&page=${page}`);
    for (const namespace of result) if (namespace.script === worker) known.set(namespace.id, namespace.class);
    if (result.length < 100) break;
  }
  if (known.size === 0) fail(`The Worker ${worker} has no Durable Object namespaces on this account.`);
  return known;
}

const classes = await namespaces();
const from = since(option("since"));
const window = `datetime_geq: "${from.toISOString()}", datetime_leq: "${new Date().toISOString()}", namespaceId_in: ${JSON.stringify([...classes.keys()])}`;

// Every room, with what it was billed for. `name` is what the room was reached by: its id.
const data = await graphql(`{ viewer { accounts(filter: { accountTag: "${account}" }) {
  durableObjectsPeriodicGroups(limit: 10000, filter: { ${window} }) {
    dimensions { namespaceId name objectId }
    sum { activeTime duration rowsWritten inboundWebsocketMsgCount }
    max { activeWebsocketConnections }
  }
} } }`);

const rooms = (data.durableObjectsPeriodicGroups ?? []).map(({ dimensions, sum, max }) => ({
  class: classes.get(dimensions.namespaceId) ?? dimensions.namespaceId,
  room: dimensions.name || `(no name) ${dimensions.objectId.slice(0, 12)}`,
  objectId: dimensions.objectId,
  namespaceId: dimensions.namespaceId,
  awakeSeconds: sum.activeTime / 1e6,
  cost: sum.duration * PRICE.perGbSecond + sum.rowsWritten * PRICE.perRowWritten + (sum.inboundWebsocketMsgCount / PRICE.messagesPerRequest) * PRICE.perRequest,
  rowsWritten: sum.rowsWritten,
  mostConnections: max.activeWebsocketConnections,
}));
rooms.sort((a, b) => b.cost - a.cost);

// For the most expensive, how long they were awake with nobody connected: five-minute spans in
// which Cloudflare counted time awake and not one connection. A room that plays on alone on
// purpose shows up here as well as one that should have gone to sleep.
const listed = rooms.slice(0, top);
for (const room of listed) {
  const spans = await graphql(`{ viewer { accounts(filter: { accountTag: "${account}" }) {
    durableObjectsPeriodicGroups(limit: 10000, filter: { ${window.replace(/namespaceId_in: [^\]]*\]/, `namespaceId: "${room.namespaceId}"`)}, objectId: "${room.objectId}" }) {
      dimensions { datetimeFiveMinutes }
      sum { activeTime }
      max { activeWebsocketConnections }
    }
  } } }`);
  let alone = 0;
  let longest = 0;
  let run = 0;
  const ordered = (spans.durableObjectsPeriodicGroups ?? []).sort((a, b) =>
    a.dimensions.datetimeFiveMinutes < b.dimensions.datetimeFiveMinutes ? -1 : 1,
  );
  for (const span of ordered) {
    if (span.sum.activeTime > 0 && span.max.activeWebsocketConnections === 0) {
      alone += span.sum.activeTime / 1e6;
      run += span.sum.activeTime / 1e6;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  room.awakeAloneSeconds = alone;
  room.longestAloneSeconds = longest;
}

const total = rooms.reduce((sum, room) => sum + room.cost, 0);
const awake = rooms.reduce((sum, room) => sum + room.awakeSeconds, 0);
const flags = (room) =>
  [
    room.longestAloneSeconds >= 600 ? "awake 10+ min with nobody connected" : room.awakeAloneSeconds >= 60 ? "awake with nobody connected" : "",
    room.awakeSeconds >= 3 * 3600 ? "awake 3+ hours" : "",
  ]
    .filter(Boolean)
    .join("; ");

if (json) {
  console.log(JSON.stringify({ since: from.toISOString(), rooms: rooms.length, awakeHours: awake / 3600, cost: total, top: listed.map((room) => ({ ...room, flags: flags(room) || undefined })) }, null, 2));
  process.exit(0);
}

const hours = (seconds) => (seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : seconds >= 60 ? `${(seconds / 60).toFixed(1)} min` : `${seconds.toFixed(1)} s`);
const money = (dollars) => (dollars >= 0.01 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(5)}`);
console.log(`Since ${from.toISOString()}: ${rooms.length} rooms, awake ${hours(awake)} in all, ${money(total)} at list price before what the plan includes.`);
console.log("");
const rows = [["Room", "Class", "Awake", "Alone", "Cost", "Most connected", ""]];
for (const room of listed) {
  rows.push([room.room, room.class, hours(room.awakeSeconds), hours(room.awakeAloneSeconds), money(room.cost), String(room.mostConnections), flags(room)]);
}
const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
if (rooms.length > listed.length) console.log(`\n${rooms.length - listed.length} more rooms, cheaper than these. --top to see more.`);
