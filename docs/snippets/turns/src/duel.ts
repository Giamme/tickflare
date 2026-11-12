import { Room, reject, type Player } from "tickflare";

type Mark = "x" | "o";
interface State {
  board: (Mark | null)[];
  marks: Record<string, Mark>; // which player plays which mark
  starts: Mark;
  turn: Mark;
  winner: Mark | "draw" | null;
  wins: Record<Mark, number>;
}
export type Command = { type: "play"; cell: number };

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const other = (mark: Mark): Mark => (mark === "x" ? "o" : "x");

// No tickRate: this room runs when a player or a timer wakes it, and sleeps the rest of the time.
export class Duel extends Room<State, Command> {
  protected override maxPlayers = 2;

  protected initialState(): State {
    return { board: Array(9).fill(null), marks: {}, starts: "x", turn: "x", winner: null, wins: { x: 0, o: 0 } };
  }

  // Everything a client sends is untrusted. Check it here.
  protected parseCommand(raw: unknown): Command {
    const c = raw as Partial<Command> | null;
    if (c?.type !== "play" || !Number.isInteger(c.cell) || c.cell! < 0 || c.cell! > 8) return reject("invalid_command");
    return { type: "play", cell: c.cell! };
  }

  protected override onJoin(player: Player): void {
    this.state.marks[player.id] = Object.values(this.state.marks).includes("x") ? "o" : "x";
  }

  protected override onLeave(player: Player): void {
    delete this.state.marks[player.id];
  }

  // The rules. A move that breaks them is refused, and nothing changes.
  protected onCommand(player: Player, command: Command): void {
    const state = this.state;
    const mark = state.marks[player.id];
    if (!mark) return reject("not_playing");
    if (state.winner) return reject("game_over");
    if (state.turn !== mark) return reject("not_your_turn");
    if (state.board[command.cell]) return reject("cell_taken");

    state.board[command.cell] = mark;
    if (LINES.some((line) => line.every((cell) => state.board[cell] === mark))) {
      state.winner = mark;
      state.wins[mark] += 1;
    } else if (state.board.every(Boolean)) {
      state.winner = "draw";
    } else {
      state.turn = other(mark);
    }
    // The room goes back to sleep. In three seconds the timer wakes it for the next game.
    if (state.winner) this.setTimer("rematch", 3000);
  }

  protected override onTimer(name: string): void {
    if (name !== "rematch") return;
    const state = this.state;
    state.starts = other(state.starts);
    state.turn = state.starts;
    state.board = Array(9).fill(null);
    state.winner = null;
  }
}
