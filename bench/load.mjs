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
  const url = `${BASE}${prefix}/${room}?player=p${n}&v=3${binary ? "&patches=b1" : ""}&key=${KEY}`;
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

/** Closes the sockets and asks the room, twice a second apart, how it is with everyone gone. */
async function closeAndAsk(sockets, room) {
  const codes = {};
  let closed = 0;
  for (const ws of sockets) {
    ws.once("close", (code) => {
      closed += 1;
      codes[code] = (codes[code] ?? 0) + 1;
    });
    ws.close();
  }
  await sleep(2000);
  const ask = async () => {
    const response = await fetch(`${BASE.replace(/^ws/, "http")}/rooms/${room}/how?player=p0&key=${KEY}`);
    return response.ok ? await response.json() : { status: response.status };
  };
  const first = await ask();
  await sleep(1000);
  const second = await ask();
  return {
    closedOf: `${closed}/${sockets.length}`,
    closeCodes: codes,
    // Ticks the room ran in a second with nobody connected: none, if it stopped as it should.
    ticksAfter: (second.tick ?? 0) - (first.tick ?? 0),
    starts: second.starts,
    connectedAfter: second.connected,
    socketsAfter: second.sockets,
  };
}

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
    const after = await closeAndAsk(sockets, room).catch((error) => ({ asking: String(error?.message ?? error) }));
    report({
      kind: "rate",
      ...after,
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

/**
 * Rooms played and left in every way a room can be left, for `minutes`, in `lanes` at once.
 * Each cycle is a room of its own, so that what Cloudflare bills each room for can be set
 * against the time it had players. Nothing here asks a room how it is: that is an event, and
 * would wake a room that ought to be asleep, or keep one awake.
 */
async function soak({ lanes, minutes }) {
  const modes = ["clean", "terminate", "close-with-restart", "restart-stay", "quiet", "clean", "terminate"];
  const ends = Date.now() + minutes * 60_000;
  const cycles = [];
  const since = new Date().toISOString();
  const random = (low, high) => low + Math.floor(Math.random() * (high - low + 1));

  async function cycle(lane, index) {
    const mode = modes[(lane + index) % modes.length];
    const room = freshRoom();
    const players = mode === "quiet" ? random(3, 12) : random(20, 100);
    const record = { lane, room, mode, players, stalls: [] };
    let sockets = [];
    const timers = [];
    try {
      sockets = await openMany("/rooms", room, players);
      record.joinedAt = Date.now();
      // As clients do: a keepalive every 25 seconds.
      for (const ws of sockets) timers.push(setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25_000));
      // One player watches the ticks: when they stop, and whether the room says hello again.
      const watcher = { lastTickAt: Date.now(), welcomes: 0, closed: null };
      sockets[0].on("message", (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString();
        if (text === "pong") return;
        const frame = JSON.parse(text);
        if (frame.t === "welcome") watcher.welcomes += 1;
        if (frame.t === "patch" || frame.t === "state" || frame.t === "welcome") {
          const gap = Date.now() - watcher.lastTickAt;
          if (gap > 3_000 && record.setupAt) record.stalls.push({ at: new Date(watcher.lastTickAt).toISOString(), seconds: +(gap / 1000).toFixed(1) });
          watcher.lastTickAt = Date.now();
        }
      });
      const codes = {};
      for (const ws of sockets) {
        ws.on("close", (code) => {
          if (!record.leaving) codes[code] = (codes[code] ?? 0) + 1;
        });
      }
      command(sockets[0], { type: "setup", units: 30, rate: 10, sight: 0 });
      record.setupAt = Date.now();
      // Moves now and then, from players in turn. A quiet room has none: only keepalives reach it.
      if (mode !== "quiet") timers.push(setInterval(() => command(sockets[random(0, sockets.length - 1)], { type: "move" }), 500));
      await sleep(mode === "quiet" ? random(240, 300) * 1000 : random(20, 60) * 1000);

      if (mode === "restart-stay") {
        // The room restarts with its players in it. If that closes their connections, they come
        // back as a client does; if it does not, the room has to find them again by itself.
        const welcomes = watcher.welcomes;
        const asked = Date.now();
        command(sockets[0], { type: "restart" });
        await sleep(1_000);
        while (Date.now() - asked < 90_000 && watcher.welcomes === welcomes && sockets[0].readyState === WebSocket.OPEN) await sleep(250);
        const kept = sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length;
        let seconds = null;
        if (watcher.welcomes > welcomes) {
          const after = Date.now();
          while (Date.now() - after < 10_000 && watcher.lastTickAt < after) await sleep(100);
          seconds = +((watcher.lastTickAt - asked) / 1000).toFixed(1);
        } else if (kept === 0) {
          for (const timer of timers.splice(0)) clearInterval(timer);
          await sleep(500);
          sockets = await openMany("/rooms", room, players);
          for (const ws of sockets) timers.push(setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25_000));
          timers.push(setInterval(() => command(sockets[random(0, sockets.length - 1)], { type: "move" }), 500));
          const ticked = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 10_000);
            sockets[0].on("message", (data, isBinary) => {
              if (!isBinary && JSON.parse(data.toString()).t === "patch") {
                clearTimeout(timeout);
                resolve(true);
              }
            });
          });
          if (ticked) seconds = +((Date.now() - asked) / 1000).toFixed(1);
        }
        record.restart = { connectionsKept: kept, reconnected: kept === 0, ticking: seconds !== null, seconds };
        await sleep(5_000);
      }

      record.leaving = true;
      record.closedByRoom = codes;
      if (mode === "close-with-restart") command(sockets[0], { type: "restart" });
      if (mode === "terminate") for (const ws of sockets) ws.terminate();
      else for (const ws of sockets) ws.close();
      record.lastLeftAt = Date.now();
    } catch (error) {
      record.error = String(error?.message ?? error).replaceAll(KEY, "…");
      record.lastLeftAt = Date.now();
      for (const ws of sockets) ws.terminate();
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
    record.playedSeconds = record.joinedAt ? +((record.lastLeftAt - record.joinedAt) / 1000).toFixed(1) : 0;
    record.joinedAt = record.joinedAt && new Date(record.joinedAt).toISOString();
    record.lastLeftAt = new Date(record.lastLeftAt).toISOString();
    delete record.leaving;
    delete record.setupAt;
    cycles.push(record);
    report({ kind: "soak-cycle", ...record });
  }

  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      // Lanes start apart, so that they do not all join and leave in the same moments.
      await sleep(lane * 3_000);
      // A quiet cycle takes up to five minutes; none starts that would end after the soak.
      for (let index = 0; Date.now() + 6 * 60_000 < ends; index++) {
        await cycle(lane, index);
        await sleep(5_000);
      }
    }),
  );
  const { writeFileSync } = await import("node:fs");
  writeFileSync("soak.json", JSON.stringify({ since, until: new Date().toISOString(), cycles }, null, 2));
  report({ kind: "soak", cycles: cycles.length, since });
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

// Not in "everything": it takes the better part of an hour.
if (wanted.includes("soak")) {
  await attempt("soak", () =>
    soak({ lanes: Number(process.env.BENCH_SOAK_LANES ?? 10), minutes: Number(process.env.BENCH_SOAK_MINUTES ?? 40) }),
  );
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
  const table = process.env.BENCH_TABLE ? JSON.parse(process.env.BENCH_TABLE) : [
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
