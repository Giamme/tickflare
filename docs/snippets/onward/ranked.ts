import { Room } from "tickflare";

interface State {
  winner: string | null;
  /** Ticks played since the last commander left; 0 while somebody is seated. */
  unattended: number;
  // ...the game
}
type Command = { type: "noop" };

const TICK_RATE = 10;
/** A match nobody is watching gets an hour to find its winner. */
const MOST_UNATTENDED_TICKS = 60 * 60 * TICK_RATE;

export class RankedMatch extends Room<State, Command> {
  protected override tickRate = TICK_RATE;

  protected initialState(): State {
    return { winner: null, unattended: 0 };
  }

  protected parseCommand(raw: unknown): Command {
    return raw as Command;
  }

  protected onCommand(): void {}

  protected override shouldTick(): boolean {
    return this.state.winner === null;
  }

  // The match counts, so it is played to the end whoever is still there.
  protected override ticksWhileEmpty(): boolean {
    return true;
  }

  protected override onTick(): void {
    // ...advance the game, which sets `winner` when there is one
    this.state.unattended = this.players.length === 0 ? this.state.unattended + 1 : 0;
    const over = this.state.winner !== null || this.state.unattended >= MOST_UNATTENDED_TICKS;
    if (!over) return;
    this.finishMatch({ winner: this.state.winner });
    if (this.players.length === 0) this.deleteRoom();
  }
}
