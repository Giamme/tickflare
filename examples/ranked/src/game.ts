// In your own project: import { Matchmaker, type MatchResult, type Player } from "tickflare";
import { Matchmaker, type MatchResult, type Player } from "../../../src/server/index.js";
import { TicTacToe, type TicTacToeCommand } from "../../tic-tac-toe/src/game.js";

export interface Env {
  ROOMS: DurableObjectNamespace<RankedTicTacToe>;
  LOBBY: DurableObjectNamespace<Lobby>;
  /** Finished matches, on their way to D1. */
  MATCHES: Queue<MatchResult>;
  DB: D1Database;
  JOIN_SECRET: string;
}

/** Pairs waiting players and reserves a room for each pair, near where they are. */
export class Lobby extends Matchmaker<Env> {
  protected override matchSize = 2;

  protected async reserveRoom(
    roomId: string,
    players: string[],
    locationHint: DurableObjectLocationHint | undefined,
  ): Promise<void> {
    const rooms = this.env.ROOMS;
    await rooms.get(rooms.idFromName(roomId), { locationHint }).reserve(roomId, players);
  }
}

/** The tic-tac-toe of the first example, with every finished game reported. */
export class RankedTicTacToe extends TicTacToe<Env> {
  protected override matchQueue = this.env.MATCHES;

  protected override onCommand(player: Player, command: TicTacToeCommand): void {
    const wasOver = this.state.winner !== null;
    super.onCommand(player, command);
    if (!wasOver && this.state.winner) this.#report("played");
  }

  // The turn clock can end a game too.
  protected override onTimer(name: string): void {
    const wasOver = this.state.winner !== null;
    super.onTimer(name);
    if (!wasOver && this.state.winner) this.#report("timeout");
  }

  protected override onLeave(player: Player): void {
    // A finished game stays on the board for whoever is still looking at it.
    if (this.state.winner) {
      delete this.state.marks[player.id];
      return;
    }
    // Walking out of a game that has started, or staying away too long, gives it to the opponent.
    const opponent = Object.keys(this.state.marks).find((id) => id !== player.id);
    if (opponent && this.state.board.some(Boolean)) {
      this.finishMatch({ winner: opponent, how: "forfeit" });
    }
    super.onLeave(player);
  }

  #report(how: string): void {
    const { winner, marks } = this.state;
    // The player id of the winner, or null for a draw.
    const winnerId = Object.keys(marks).find((id) => marks[id] === winner) ?? null;
    this.finishMatch({ winner: winnerId, how: winnerId ? how : "draw" });
  }
}
