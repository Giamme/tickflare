import { Room, type Player } from "tickflare";

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

  // A seat was given up, on purpose or by staying away. `players` still has the one leaving.
  protected override onLeave(player: Player): void {
    const anyoneElse = this.players.some((seated) => seated.id !== player.id);
    // Nobody is left to play for. Give them ten minutes to come back, then call it.
    if (!anyoneElse && !this.state.over) this.setTimer("abandoned", 10 * 60_000);
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
