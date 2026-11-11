// In your own project: import { Room, reject, type Player } from "tickflare";
import { Room, reject, type Player } from "../../../src/server/index.js";

export type Mark = "X" | "O";

export interface TicTacToeState {
  board: (Mark | null)[];
  /** Player id to mark. */
  marks: Record<string, Mark>;
  turn: Mark;
  winner: Mark | "draw" | null;
  /** When the player on turn runs out of time, in epoch milliseconds. Null while no clock runs. */
  turnEndsAt: number | null;
}

export type TicTacToeCommand = { type: "place"; cell: number } | { type: "rematch" };

/** Time to make a move before the other player wins. */
const TURN_MS = 30_000;
/** How long a disconnected player keeps their seat. */
const AWAY_MS = 30_000;

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export class TicTacToe<Env = Cloudflare.Env> extends Room<TicTacToeState, TicTacToeCommand, Env> {
  protected override maxPlayers = 2;
  // A player who drops keeps their seat for a while; then onLeave runs and it is free again.
  protected override seatTimeoutMs = AWAY_MS;

  protected initialState(): TicTacToeState {
    return {
      board: Array<Mark | null>(9).fill(null),
      marks: {},
      turn: "X",
      winner: null,
      turnEndsAt: null,
    };
  }

  protected parseCommand(raw: unknown): TicTacToeCommand {
    const input = raw as { type?: unknown; cell?: unknown } | null;
    if (input?.type === "rematch") return { type: "rematch" };
    if (input?.type === "place" && Number.isInteger(input.cell)) {
      const cell = input.cell as number;
      if (cell >= 0 && cell < 9) return { type: "place", cell };
    }
    return reject("invalid_command");
  }

  protected override onJoin(player: Player): void {
    const state = this.state;
    state.marks[player.id] = Object.values(state.marks).includes("X") ? "O" : "X";
    if (Object.keys(state.marks).length === 2) this.#startClock();
  }

  protected onCommand(player: Player, command: TicTacToeCommand): void {
    const state = this.state;
    const mark = state.marks[player.id];
    if (!mark) reject("not_seated");
    if (Object.keys(state.marks).length < 2) reject("waiting_for_opponent");

    if (command.type === "rematch") {
      if (!state.winner) reject("game_in_progress");
      this.#resetBoard();
      this.#startClock();
      return;
    }

    if (state.winner) reject("game_over");
    if (state.turn !== mark) reject("not_your_turn");
    if (state.board[command.cell]) reject("cell_taken");

    state.board[command.cell] = mark;
    if (LINES.some((line) => line.every((cell) => state.board[cell] === mark))) {
      state.winner = mark;
      this.#stopClock();
    } else if (state.board.every(Boolean)) {
      state.winner = "draw";
      this.#stopClock();
    } else {
      state.turn = mark === "X" ? "O" : "X";
      this.#startClock();
    }
  }

  /** The player left, or stayed away too long: free their mark and wait for a new opponent. */
  protected override onLeave(player: Player): void {
    delete this.state.marks[player.id];
    this.#resetBoard();
    this.#stopClock();
  }

  protected override onTimer(name: string): void {
    if (name === "turn") {
      // Whoever was on the clock ran out of time.
      this.state.winner = this.state.turn === "X" ? "O" : "X";
      this.state.turnEndsAt = null;
    }
  }

  #resetBoard(): void {
    this.state.board.fill(null);
    this.state.turn = "X";
    this.state.winner = null;
  }

  #startClock(): void {
    this.state.turnEndsAt = this.setTimer("turn", TURN_MS);
  }

  #stopClock(): void {
    this.clearTimer("turn");
    this.state.turnEndsAt = null;
  }
}
