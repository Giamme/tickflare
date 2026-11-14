<script setup lang="ts">
/**
 * A model of an event-mode room, run in the page: noughts and crosses. The
 * room is asleep unless a move, a connection or a timer wakes it; it checks
 * the move, and sends both screens the board. Nothing here talks to a server.
 */
import { reactive, ref } from "vue";
import { useLoop } from "./demo/loop";
import { hue, names, other, who, type Who } from "./demo/shared";
import { createWires } from "./demo/wires";

type Cell = Who | null;
interface Game {
  board: Cell[];
  turn: Who;
  winner: Who | "draw" | null;
  line: number[];
  wins: Record<Who, number>;
}

const LAG_MS = 420;
const REMATCH_MS = 2800;
/** How long the room is shown awake. Handling a move really takes a few milliseconds. */
const AWAKE_MS = 520;
const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const refusals = { not_your_turn: "not your turn", cell_taken: "that square is taken", game_over: "the game is over" };

const copy = (game: Game): Game => ({ ...game, board: [...game.board], line: [...game.line], wins: { ...game.wins } });
const lineIn = (board: Cell[]) => LINES.find(([a, b, c]) => board[a!] && board[a!] === board[b!] && board[a!] === board[c!]);

// ---- The room: asleep until something happens -----------------------------------------------

const room = reactive<Game>({ board: Array<Cell>(9).fill(null), turn: "ada", winner: null, line: [], wins: { ada: 0, grace: 0 } });
const joined: Record<Who, boolean> = { ada: true, grace: true };
let starts: Who = "ada";
let timerAt: number | null = null;
let awakeUntil = 0;

function wake(): void {
  ui.wakes += 1;
  ui.awake = true;
  awakeUntil = clock + AWAKE_MS;
}

function broadcast(): void {
  const game = copy(room);
  for (const player of who) {
    if (joined[player]) wires.send(clock, player, false, "state", "patch", () => receive(player, game), LAG_MS + 120);
  }
}

/** The room's `onCommand`: check the move against the rules, then apply it. */
function roomCommand(player: Who, cell: number): void {
  if (!joined[player]) return;
  wake();
  const refusal = room.winner ? "game_over" : room.turn !== player ? "not_your_turn" : room.board[cell] ? "cell_taken" : null;
  if (refusal) {
    wires.send(clock, player, false, "reject", "reject", () => {
      screens[player].pending = null;
      screens[player].note = `Refused: ${refusals[refusal]}`;
      screens[player].noteUntil = clock + 2600;
    });
    narration.value = `The room refused ${names[player]}'s move: ${refusals[refusal]}. Nothing changed, so nobody else hears of it.`;
    return;
  }

  room.board[cell] = player;
  const line = lineIn(room.board);
  if (line) {
    room.winner = player;
    room.line = line;
    room.wins[player] += 1;
  } else if (room.board.every(Boolean)) {
    room.winner = "draw";
  } else {
    room.turn = other(player);
  }
  wires.send(clock, player, false, "ack", "ack", () => {});
  broadcast();

  if (room.winner) {
    timerAt = clock + REMATCH_MS;
    ui.timer = true;
    narration.value = `${room.winner === "draw" ? "A draw" : `${names[room.winner]} won`}. The room set a timer for the next game and went back to sleep.`;
  }
}

/** The room's `onTimer`: the only thing that happens without a player. */
function roomTimer(): void {
  timerAt = null;
  ui.timer = false;
  wake();
  starts = other(starts);
  Object.assign(room, { board: Array<Cell>(9).fill(null), turn: starts, winner: null, line: [] });
  broadcast();
  narration.value = `The timer woke the room. New game: ${names[starts]} starts.`;
}

// ---- The screens: they show the last board they were sent -----------------------------------

const screens = reactive(
  Object.fromEntries(
    who.map((player) => [player, { game: copy(room), pending: null as number | null, note: "", noteUntil: 0, thinkAt: 900, handsOffUntil: 0 }]),
  ) as Record<Who, { game: Game; pending: number | null; note: string; noteUntil: number; thinkAt: number; handsOffUntil: number }>,
);

function receive(player: Who, game: Game): void {
  const screen = screens[player];
  screen.game = game;
  if (screen.pending !== null && game.board[screen.pending]) screen.pending = null;
  screen.thinkAt = clock + 900 + Math.random() * 900;
}

function command(player: Who, cell: number): void {
  screens[player].pending = cell;
  wires.send(clock, player, true, "cmd", "cmd", () => roomCommand(player, cell));
}

/** Until the visitor takes a side, each player plays a passable game. */
function think(player: Who): void {
  const screen = screens[player];
  if (!ui.connected[player] || clock < screen.thinkAt || clock < screen.handsOffUntil) return;
  const { board, turn, winner } = screen.game;
  if (winner || turn !== player || screen.pending !== null) return;
  screen.thinkAt = clock + 1200;

  const free = board.flatMap((cell, index) => (cell ? [] : [index]));
  const finishes = (side: Who) => free.find((index) => lineIn(board.map((cell, at) => (at === index ? side : cell))));
  const careless = Math.random() < 0.3;
  const choice =
    (careless ? undefined : (finishes(player) ?? finishes(other(player)) ?? (board[4] ? undefined : 4))) ??
    free[Math.floor(Math.random() * free.length)];
  if (choice !== undefined) command(player, choice);
}

// ---- What the visitor can do ----------------------------------------------------------------

let clock = 0;

const ui = reactive({
  connected: { ada: true, grace: true } as Record<Who, boolean>,
  wakes: 0,
  awake: false,
  timer: false,
});
const narration = ref("Tap a square to play a move. Try one out of turn.");
const root = ref<HTMLElement | null>(null);

function tap(player: Who, cell: number): void {
  if (!ui.connected[player]) return;
  // The side the visitor plays stops playing by itself for a while.
  screens[player].handsOffUntil = clock + 15_000;
  command(player, cell);
  narration.value = `${names[player]} sent a move. The room wakes, checks it against the rules and answers.`;
  if (!playing.value) play();
}

function toggleTab(player: Who): void {
  if (ui.connected[player]) {
    ui.connected[player] = false;
    joined[player] = false;
    wires.drop(player);
    screens[player].pending = null;
    wake();
    narration.value = `${names[player]} closed the tab. The board and her seat are in storage, and the room sleeps until she is back.`;
  } else {
    ui.connected[player] = true;
    joined[player] = true;
    wake();
    const game = copy(room);
    wires.send(clock, player, false, "welcome", "welcome", () => receive(player, game));
    screens[player].handsOffUntil = 0;
    narration.value = `${names[player]} is back. One welcome frame carries the whole board.`;
  }
}

function hint(player: Who): string {
  const screen = screens[player];
  if (!ui.connected[player]) return "The room keeps the seat";
  if (screen.note) return screen.note;
  const { winner, turn } = screen.game;
  if (winner) return winner === "draw" ? "A draw" : winner === player ? `${names[player]} won` : `${names[winner]} won`;
  return turn === player ? `${names[player]}'s turn: tap a square` : `Waiting for ${names[turn]}`;
}

const squareLabel = (cell: Cell, index: number) => `Square ${index + 1}, ${cell ? `taken by ${names[cell]}` : "empty"}`;

// ---- The loop -------------------------------------------------------------------------------

function advance(ms: number): void {
  clock += ms;
  if (timerAt !== null && clock >= timerAt) roomTimer();
  if (ui.awake && clock >= awakeUntil) ui.awake = false;
  for (const player of who) {
    const screen = screens[player];
    if (screen.note && clock >= screen.noteUntil) screen.note = "";
    think(player);
  }
  wires.move(clock);
}

const { playing, vertical, waiting, play, pause } = useLoop(root, { setup() {}, advance, draw() {} });
const wires = createWires(vertical, LAG_MS);
</script>

<template>
  <figure ref="root" class="tf-demo" :class="{ vertical }">
    <div class="stage">
      <template v-for="(p, index) in who" :key="p">
        <div class="panel screen" :class="p">
          <div class="bar">
            <span class="title"><i :style="{ background: hue[p] }" /><span>{{ names[p] }}<span class="more">'s screen</span></span></span>
            <button type="button" class="tab" :aria-label="`${ui.connected[p] ? 'Close' : 'Open'} ${names[p]}'s tab`" @click="toggleTab(p)">
              {{ ui.connected[p] ? "Close" : "Open" }}<span class="more"> tab</span>
            </button>
          </div>
          <div class="glass">
            <div class="board" role="group" :aria-label="`${names[p]}'s board`">
              <button
                v-for="(cell, at) in screens[p].game.board"
                :key="at"
                type="button"
                class="square"
                :class="{ won: screens[p].game.line.includes(at) }"
                :aria-label="squareLabel(cell, at)"
                :disabled="!ui.connected[p]"
                @click="tap(p, at)"
              >
                <svg v-if="cell ?? (screens[p].pending === at ? p : null)" viewBox="0 0 24 24" :class="{ ghost: !cell }" :style="{ color: hue[cell ?? p] }" aria-hidden="true">
                  <path v-if="(cell ?? p) === 'ada'" d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                  <circle v-else cx="12" cy="12" r="6.5" />
                </svg>
              </button>
            </div>
            <p v-if="!ui.connected[p]" class="closed">Tab closed</p>
          </div>
          <p class="foot hint" :class="{ refused: screens[p].note && ui.connected[p] }">{{ hint(p) }}</p>
        </div>

        <div :ref="(el) => el && (wires.hosts[p] = el as HTMLElement)" class="wire" :class="[p, { cut: !ui.connected[p] }]" aria-hidden="true" />

        <div v-if="index === 0" class="panel room" :class="{ awake: ui.awake }">
          <div class="bar">
            <span class="title">Room <span class="muted">duel</span></span>
            <span class="count">woken {{ ui.wakes }} {{ ui.wakes === 1 ? "time" : "times" }}</span>
          </div>
          <div class="glass">
            <div class="board" role="img" aria-label="The room's board: the one that counts.">
              <span v-for="(cell, at) in room.board" :key="at" class="square" :class="{ won: room.line.includes(at) }">
                <svg v-if="cell" viewBox="0 0 24 24" :style="{ color: hue[cell] }" aria-hidden="true">
                  <path v-if="cell === 'ada'" d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                  <circle v-else cx="12" cy="12" r="6.5" />
                </svg>
              </span>
            </div>
            <p class="doze">{{ ui.awake ? "Awake" : ui.timer ? "Asleep, timer set" : "Asleep" }}</p>
          </div>
          <ul class="foot seats" aria-label="Seats">
            <li v-for="s in who" :key="s">
              <i :style="{ background: hue[s] }" />{{ names[s] }}
              <span :class="{ away: !ui.connected[s] }">{{ ui.connected[s] ? `${room.wins[s]} won` : "away, seat kept" }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>
    <figcaption>
      <p class="narration" aria-live="polite">{{ waiting ? "Press Play, or tap a square to play a move." : narration }}</p>
      <p class="caption">
        <button type="button" class="playpause" @click="playing ? pause(true) : play()">{{ playing ? "Pause" : "Play" }}</button>
        <span class="long">Noughts and crosses, simulated in your browser. The room runs only when a move or a timer wakes it, and
        that is all it is billed for: </span><span class="key pill">cmd</span> <span class="more">moves </span>in, <span class="key pill state">patch</span> <span class="more">what changed </span>out.
      </p>
    </figcaption>
  </figure>
</template>

<style scoped>
.board {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(0, 1fr));
  gap: 5%;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 9%;
}

.square {
  display: grid;
  place-items: center;
  border-radius: 16%;
  background: #18213a;
  transition: background-color 0.2s;
}

button.square:not(:disabled) {
  cursor: pointer;
}

button.square:not(:disabled):hover {
  background: #243154;
}

button.square:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

.square.won {
  background: #33416a;
}

.square svg {
  width: 72%;
  height: 72%;
  fill: none;
  stroke: currentColor;
  stroke-width: 3.2;
  stroke-linecap: round;
}

.square svg.ghost {
  opacity: 0.35;
}

/* The room's own board: paper, not a screen. It dims while the room sleeps. */
.room .square {
  background: var(--tf-paper);
}

.room .square.won {
  background: var(--tf-line);
}

.room .board {
  padding: 6% 13% 20%;
  opacity: 0.45;
  transition: opacity 0.25s;
}

.room.awake .board {
  opacity: 1;
}

.room .glass {
  transition: box-shadow 0.2s;
}

.room.awake .glass {
  box-shadow: 0 0 0 2.5px var(--tf-flare);
}

.doze {
  position: absolute;
  inset: auto 0 5% 0;
  margin: 0;
  text-align: center;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 650;
  font-size: 13px;
  line-height: 1.2;
  color: var(--tf-slate);
}

.room.awake .doze {
  color: var(--tf-flare-text);
}
</style>
