// After a soak: what Cloudflare billed each room for, set against the time it had players.
//
// Reads soak.json and namespaces.json, as the workflow leaves them, and needs
// CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BENCH_URL and BENCH_KEY. Waits for
// Cloudflare's analytics to settle, prints a line for every room, then the log of each room
// that was awake for much longer than it had players. Asking a room for its log wakes it, so
// that is done last, after the analytics have been read.
import { readFileSync } from "node:fs";

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, BENCH_URL: base, BENCH_KEY: key } = process.env;
const soak = JSON.parse(readFileSync("soak.json", "utf8"));
const namespaces = JSON.parse(readFileSync("namespaces.json", "utf8"));
const ids = JSON.stringify(namespaces.map(({ id }) => id));
/** A room is a hit when Cloudflare counted it awake this many seconds longer than it had players. */
const SLACK_SECONDS = Number(process.env.SOAK_SLACK_SECONDS ?? 60);
const PATIENCE_SECONDS = Number(process.env.WAIT_SECONDS ?? 1200);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (kind, value) => console.log(`${kind} ${JSON.stringify(value)}`);

async function ask(query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) throw new Error(`analytics refused (${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`);
  return body.data?.viewer?.accounts?.[0];
}

/** Active time by room, in seconds, and what else Cloudflare counted for each. */
async function byRoom() {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const data = await ask(`{ viewer { accounts(filter: { accountTag: "${account}" }) {
    durableObjectsPeriodicGroups(limit: 2000, filter: { datetime_geq: "${soak.since}", datetime_leq: "${until}", namespaceId_in: ${ids} }) {
      dimensions { name }
      sum { activeTime cpuTime duration inboundWebsocketMsgCount outboundWebsocketMsgCount exceededMemoryErrors exceededCpuErrors fatalInternalErrors }
      max { activeWebsocketConnections }
    }
  } } }`);
  const rooms = new Map();
  for (const { dimensions, sum, max } of data?.durableObjectsPeriodicGroups ?? []) {
    rooms.set(dimensions.name, {
      active: sum.activeTime / 1e6,
      cpu: sum.cpuTime / 1e6,
      duration: sum.duration,
      messagesIn: sum.inboundWebsocketMsgCount,
      messagesOut: sum.outboundWebsocketMsgCount,
      sockets: max.activeWebsocketConnections,
      errors: sum.exceededMemoryErrors + sum.exceededCpuErrors + sum.fatalInternalErrors,
    });
  }
  return rooms;
}

// The analytics lag by minutes and fill in over a while: wait until two looks a minute apart agree.
let rooms = new Map();
let last = "";
const started = Date.now();
while (Date.now() - started < PATIENCE_SECONDS * 1000) {
  await sleep(60_000);
  try {
    rooms = await byRoom();
  } catch (error) {
    console.log(String(error.message));
    continue;
  }
  const total = [...rooms.values()].reduce((sum, room) => sum + room.active, 0);
  const now = `${rooms.size}:${total.toFixed(1)}`;
  console.log(`after ${Math.round((Date.now() - started) / 1000)} s: ${rooms.size} rooms counted, ${total.toFixed(0)} s awake in all`);
  if (rooms.size >= soak.cycles.length * 0.9 && now === last) break;
  last = now;
}

const hits = [];
let played = 0;
let awake = 0;
for (const cycle of soak.cycles) {
  const counted = rooms.get(cycle.room);
  played += cycle.playedSeconds;
  awake += counted?.active ?? 0;
  const over = counted ? counted.active - cycle.playedSeconds : null;
  const line = {
    room: cycle.room,
    mode: cycle.mode,
    players: cycle.players,
    played: cycle.playedSeconds,
    awake: counted ? +counted.active.toFixed(1) : "not counted",
    over: over === null ? null : +over.toFixed(1),
    sockets: counted?.sockets,
    errors: counted?.errors || undefined,
    stalls: cycle.stalls.length ? cycle.stalls : undefined,
    restart: cycle.restart,
    closedByRoom: Object.keys(cycle.closedByRoom ?? {}).length ? cycle.closedByRoom : undefined,
    error: cycle.error,
  };
  print("ROOM", line);
  if (over !== null && over > SLACK_SECONDS) hits.push(cycle);
}

const restarts = soak.cycles.filter((cycle) => cycle.restart);
const quiet = soak.cycles.filter((cycle) => cycle.mode === "quiet");
print("SUMMARY", {
  rooms: soak.cycles.length,
  counted: soak.cycles.filter((cycle) => rooms.has(cycle.room)).length,
  roomHoursPlayed: +(played / 3600).toFixed(2),
  roomHoursAwake: +(awake / 3600).toFixed(2),
  awakeLongerThanPlayedBy: `${SLACK_SECONDS}+ s: ${hits.length}`,
  quietRooms: quiet.length,
  quietRoomsThatStalled: quiet.filter((cycle) => cycle.stalls.length > 0).length,
  restartsTickingAgain: `${restarts.filter((cycle) => cycle.restart.ticking).length} of ${restarts.length}`,
  restartsThatKeptConnections: restarts.filter((cycle) => cycle.restart.connectionsKept > 0).length,
  restartSeconds: restarts.map((cycle) => cycle.restart.seconds),
  errors: soak.cycles.filter((cycle) => cycle.error).length,
});

// Last, because asking wakes the room: the log of each room that stayed awake.
for (const cycle of hits.slice(0, 12)) {
  try {
    const response = await fetch(`${base.replace(/^ws/, "http")}/rooms/${cycle.room}/how?player=p0&log=1&key=${key}`);
    const body = await response.json();
    print("LOG", { room: cycle.room, mode: cycle.mode, lastLeftAt: cycle.lastLeftAt, starts: body.starts, tick: body.tick });
    for (const line of body.lines) console.log(`  ${line}`);
  } catch (error) {
    print("LOG", { room: cycle.room, error: String(error?.message ?? error).replaceAll(key, "…") });
  }
}
