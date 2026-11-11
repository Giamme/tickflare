// In your own project: import { Room, reject, type Player } from "tickflare";
import { Room, reject, type Player } from "../../../src/server/index.js";

export type Mark = "X" | "O";

export interface TicTacToeState {
  board: (Mark | null)[];
  /** Player id to mark. The first player to join is X. */
  marks: Record<string, Mark>;
  turn: Mark;
  winner: Mark | "draw" | null;
}

export type TicTacToeCommand = { type: "place"; cell: number } | { type: "rematch" };

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export class TicTacToe extends Room<TicTacToeState, TicTacToeCommand> {
  protected override maxPlayers = 2;

  protected initialState(): TicTacToeState {
    return { board: Array<Mark | null>(9).fill(null), marks: {}, turn: "X", winner: null };
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
    this.state.marks[player.id] = Object.keys(this.state.marks).length === 0 ? "X" : "O";
  }

  protected onCommand(player: Player, command: TicTacToeCommand): void {
    const state = this.state;
    const mark = state.marks[player.id];
    if (!mark) reject("not_seated");

    if (command.type === "rematch") {
      if (!state.winner) reject("game_in_progress");
      state.board.fill(null);
      state.turn = "X";
      state.winner = null;
      return;
    }

    if (Object.keys(state.marks).length < 2) reject("waiting_for_opponent");
    if (state.winner) reject("game_over");
    if (state.turn !== mark) reject("not_your_turn");
    if (state.board[command.cell]) reject("cell_taken");

    state.board[command.cell] = mark;
    if (LINES.some((line) => line.every((cell) => state.board[cell] === mark))) {
      state.winner = mark;
    } else if (state.board.every(Boolean)) {
      state.winner = "draw";
    } else {
      state.turn = mark === "X" ? "O" : "X";
    }
  }
}
