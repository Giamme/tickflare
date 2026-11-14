// Puts load on the benchmark Worker and prints what it measured, one JSON object a line.
//
//   BENCH_URL=wss://host BENCH_KEY=… node bench/load.mjs [rates] [wire] [latency] [idle]
//
// With no arguments it runs everything. It needs the `ws` package, which can turn compression
// off and count the bytes that arrive, neither of which Node's own WebSocket can.
import WebSocket from "ws";

const BASE = process.env.BENCH_URL;
const KEY = process.env.BENCH_KEY;
if (!BASE || !KEY) throw new Error("BENCH_URL and BENCH_KEY are needed");
const wanted = process.argv.slice(2);
const runs = (name) => wanted.length === 0 || wanted.includes(name);
const MEASURE_MS = Number(process.env.BENCH_MEASURE_MS ?? 8000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = Date.now().toString(36);
let rooms = 0;
const freshRoom = () => `r${stamp}-${rooms++}`;
const report = (result) => console.log("RESULT " + JSON.stringify(result));

function open(prefix, room, n, { deflate = true, binary = false } = {}) {
  const url = `${BASE}${prefix}/${room}?player=p${n}&v=2${binary ? "&patches=b1" : ""}&key=${KEY}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: deflate, handshakeTimeout: 20_000 });
    ws.once("open", () => {
      // What arrives at the WebSocket layer: frame headers and payloads as sent, compressed or not.
      ws.wire = 0;
      ws._socket.on("data", (chunk) => (ws.wire += chunk.length));
      resolve(ws);
    });
    ws.once("error", (error) => reject(new Error(`socket ${n}: ${error.message}`)));
  });
}

async function openMany(prefix, room, players, options) {
  const sockets = [];
  for (let n = 0; n < players; n += 50) {
    const batch = Array.from({ length: Math.min(50, players - n) }, (_, i) => n + i);
    for (let attempt = 0; ; attempt++) {
      try {
        sockets.push(...(await Promise.all(batch.map((id) => open(prefix, room, id, options)))));
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await sleep(500);
      }
    }
  }
  return sockets;
}

const closeAll = async (sockets) => {
  for (const ws of sockets) ws.close();
  await sleep(500);
};

let nextId = 1;
const command = (ws, data) => ws.send(JSON.stringify({ t: "cmd", id: nextId++, data }));

/** Watches one socket for `ms`: the ticks it was sent, the frames, and their size as JSON and on the wire. */
async function watch(ws, ms, binary) {
  let frames = 0;
  let bytes = 0;
  let first;
  let last;
  const arrivals = [];
  const onMessage = (data, isBinary) => {
    frames += 1;
    bytes += data.length;
    arrivals.push(performance.now());
    if (isBinary) return;
    const tick = JSON.parse(data.toString()).tick;
    if (typeof tick === "number") {
      first ??= tick;
      last = tick;
    }
  };
  ws.on("message", onMessage);
  const wireBefore = ws.wire;
  const started = performance.now();
  await sleep(ms);
  ws.off("message", onMessage);
  const seconds = (performance.now() - started) / 1000;
  // How unevenly the frames arrived: the middle half of the gaps between them, in milliseconds.
  const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]).sort((a, b) => a - b);
  return {
    seconds,
    frames,
    bytes,
    wire: ws.wire - wireBefore,
    ticks: binary || first === undefined ? frames : last - first,
    gapP50: gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(1) : null,
    gapP95: gaps.length ? +gaps[Math.floor(gaps.length * 0.95)].toFixed(1) : null,
  };
}

/** A room asked for `rate` ticks a second, with everything in it moving on every tick. */
async function tickRate({ units, rate, sight, players, cps = 0 }) {
  const room = freshRoom();
  const opening = performance.now();
  const sockets = await openMany("/rooms", room, players);
  const joined = (performance.now() - opening) / 1000;
  try {
    // Every join is told to everyone. Wait for that to be over: a second with nothing said.
    let last = performance.now();
    let said = 0;
    const heard = () => {
      last = performance.now();
      said += 1;
    };
    sockets[0].on("message", heard);
    const wireBefore = sockets[0].wire;
    const waiting = performance.now();
    while (performance.now() - last < 1000 && performance.now() - waiting < 180_000) await sleep(100);
    sockets[0].off("message", heard);
    const settled = Math.max(0, (performance.now() - waiting) / 1000 - 1);
    const joinKB = (sockets[0].wire - wireBefore) / 1024;

    command(sockets[0], { type: "setup", units, rate, sight });
    await sleep(2500);
    const timer =
      cps > 0
        ? setInterval(() => {
            // `cps` commands a second in all, from players in turn.
            for (let n = 0; n < cps / 10; n++) command(sockets[(nextId + n) % sockets.length], { type: "move" });
          }, 100)
        : null;
    const seen = await watch(sockets[0], MEASURE_MS, false);
    if (timer) clearInterval(timer);
    report({
      kind: "rate",
      room,
      ticks: seen.ticks,
      units,
      sight,
      players,
      cps,
      asked: rate,
      managed: +(seen.ticks / seen.seconds).toFixed(1),
      wireKBps: +(seen.wire / seen.seconds / 1024).toFixed(1),
      // How long the players took to connect, how long the room then went on telling them of
      // each other, and what one of them was sent of that after the last had connected.
      joined: +joined.toFixed(1),
      settled: +settled.toFixed(1),
      joinKB: +joinKB.toFixed(0),
      framesAfterJoining: said,
      gapP50: seen.gapP50,
      gapP95: seen.gapP95,
      compressed: sockets[0].extensions,
    });
  } finally {
    await closeAll(sockets);
  }
}

/** What a unit that moves costs on the wire, each tick: one player, 200 units that walk. */
async function wire({ walkers, deflate, binary }) {
  const units = 200;
  const room = freshRoom();
  const sockets = await openMany("/rooms", room, 1, { deflate, binary });
  try {
    command(sockets[0], { type: "setup", units, rate: 20, sight: 0, walkers });
    await sleep(2500);
    const seen = await watch(sockets[0], MEASURE_MS, binary);
    report({
      kind: "wire",
      room,
      walkers,
      binary,
      asked: deflate,
      compressed: sockets[0].extensions,
      ticks: seen.ticks,
      perUnitAsSent: +(seen.bytes / seen.ticks / units).toFixed(1),
      perUnitOnWire: +(seen.wire / seen.ticks / units).toFixed(1),
    });
  } finally {
    await closeAll(sockets);
  }
}

/** How long the way to the Worker and back takes, with no room involved. */
async function baseline() {
  const url = BASE.replace(/^ws/, "http") + `/health?key=${KEY}`;
  const times = [];
  for (let n = 0; n < 30; n++) {
    const sent = performance.now();
    await (await fetch(url)).text();
    times.push(performance.now() - sent);
  }
  // The first few open the connection.
  const warm = times.slice(5).sort((a, b) => a - b);
  report({ kind: "baseline", min: +warm[0].toFixed(1), p50: +warm[Math.floor(warm.length / 2)].toFixed(1), max: +warm.at(-1).toFixed(1) });
}

/** How long a command takes to come back answered, one at a time. */
async function latency({ ticking, type = "move" }) {
  const room = freshRoom();
  const [ws] = await openMany("/rooms", room, 1);
  try {
    if (ticking) {
      command(ws, { type: "setup", units: 10, rate: ticking, sight: 0 });
      await sleep(1500);
    }
    const waiting = new Map();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(data.toString());
      if (frame.t === "ack") waiting.get(frame.id)?.();
    });
    const times = [];
    for (let n = 0; n < 100; n++) {
      const id = nextId;
      const answered = new Promise((resolve) => waiting.set(id, resolve));
      const sent = performance.now();
      command(ws, { type });
      await answered;
      times.push(performance.now() - sent);
      waiting.delete(id);
      if (ticking) await sleep(7);
    }
    times.sort((a, b) => a - b);
    report({
      kind: "latency",
      room,
      ticking,
      // "noop" changes nothing, so nothing is stored before it is answered.
      command: type,
      min: +times[0].toFixed(1),
      p50: +times[50].toFixed(1),
      p95: +times[95].toFixed(1),
      max: +times[99].toFixed(1),
    });
  } finally {
    await closeAll([ws]);
  }
}

/** Players connected to a room in which nothing happens, with the keepalive a client sends. */
async function idle({ players, seconds }) {
  const room = freshRoom();
  const sockets = await openMany("/idle", room, players);
  const since = new Date().toISOString();
  let pongs = 0;
  for (const ws of sockets) ws.on("message", (data) => data.toString() === "pong" && pongs++);
  const timer = setInterval(() => sockets.forEach((ws) => ws.send("ping")), 25_000);
  await sleep(seconds * 1000);
  clearInterval(timer);
  const stillOpen = sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length;
  // The room wakes for this one, and answers: it is still there, with its state.
  const [ws] = sockets;
  const answered = new Promise((resolve) => ws.once("message", resolve));
  command(ws, { type: "move" });
  const woke = await Promise.race([answered.then(() => true), sleep(5000).then(() => false)]);
  report({ kind: "idle", room, players, seconds, since, until: new Date().toISOString(), stillOpen, pongs, woke });
  await closeAll(sockets);
}

async function attempt(name, run) {
  try {
    await run();
  } catch (error) {
    report({ kind: "error", in: name, message: String(error?.message ?? error).replaceAll(KEY, "…") });
  }
}

try {
  const trace = await (await fetch(BASE.replace(/^ws/, "http") + "/cdn-cgi/trace")).text();
  report({ kind: "where", colo: /colo=(\w+)/.exec(trace)?.[1] ?? null, loc: /loc=(\w+)/.exec(trace)?.[1] ?? null });
} catch {
  report({ kind: "where", colo: null });
}

if (runs("idle")) await attempt("idle", () => idle({ players: 5, seconds: Number(process.env.BENCH_IDLE_SECONDS ?? 90) }));

if (runs("latency")) {
  await attempt("baseline", baseline);
  await attempt("latency noop", () => latency({ ticking: 0, type: "noop" }));
  await attempt("latency", () => latency({ ticking: 0 }));
  await attempt("latency ticking", () => latency({ ticking: 20 }));
}

if (runs("wire")) {
  for (const walkers of ["int", "dec1", "float"]) {
    for (const [deflate, binary] of [[false, false], [true, false], [false, true], [true, true]]) {
      await attempt(`wire ${walkers}`, () => wire({ walkers, deflate, binary }));
    }
  }
}

if (runs("rates")) {
  const table = [
    { units: 100, sight: 0, players: 200, rate: 10 },
    { units: 100, sight: 0, players: 1000, rate: 10 },
    { units: 1000, sight: 100, players: 200, rate: 10 },
    { units: 1000, sight: 100, players: 500, rate: 10 },
    { units: 1000, sight: 100, players: 1000, rate: 10 },
    { units: 5000, sight: 100, players: 100, rate: 10 },
    { units: 20000, sight: 100, players: 20, rate: 10 },
    { units: 1000, sight: 100, players: 100, rate: 30 },
    { units: 1000, sight: 100, players: 50, rate: 60 },
    { units: 1000, sight: 100, players: 100, rate: 10, cps: 480 },
    { units: 5000, sight: 100, players: 100, rate: 10, cps: 480 },
    { units: 20000, sight: 100, players: 20, rate: 10, cps: 400 },
  ];
  for (const row of table) await attempt(`rate ${JSON.stringify(row)}`, () => tickRate(row));
}
process.exit(0);
