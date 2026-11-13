import { Room } from "tickflare";

interface State {
  over: boolean;
  // ...the game
}
type Command = { type: "noop" };

export class Match extends Room<State, Command> {
  protected override tickRate = 10;
  // A closed tab gives up its seat after half a minute.
  protected override seatTimeoutMs = 30_000;

  protected initialState(): State {
    return { over: false };
  }

  protected parseCommand(raw: unknown): Command {
    return raw as Command;
  }

  protected onCommand(): void {}

  protected override shouldTick(): boolean {
    return !this.state.over;
  }

  // The last seat was given up, on purpose or by staying away. Nobody is left to play for.
  protected override onEmpty(): void {
    // A match that is over can go at once. One that is not gets ten minutes for somebody to return.
    if (this.state.over) this.deleteRoom();
    else this.setTimer("abandoned", 10 * 60_000);
  }

  protected override onJoin(): void {
    this.clearTimer("abandoned");
  }

  protected override onTimer(name: string): void {
    if (name !== "abandoned" || this.players.length > 0) return;
    // Nobody came back. The room and everything it stored go.
    this.deleteRoom();
  }
}
