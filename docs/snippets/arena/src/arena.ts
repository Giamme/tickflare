import { Room, reject, type Player } from "tickflare";

interface Point {
  x: number;
  y: number;
}
interface Dot extends Point {
  tx: number;
  ty: number;
  score: number;
}
interface State {
  dots: Record<string, Dot>;
  pellets: Record<string, Point>;
  nextPellet: number;
}
export type Command = { type: "move"; x: number; y: number };

const SIZE = 100;
const SIGHT = 30; // how far a player can see
const SPEED = 26; // units a second

const near = (a: Point, b: Point, radius: number) => Math.hypot(a.x - b.x, a.y - b.y) <= radius;
const round = (n: number) => Math.round(n * 10) / 10;
const somewhere = (): Point => ({ x: 8 + Math.random() * (SIZE - 16), y: 8 + Math.random() * (SIZE - 16) });

export class Arena extends Room<State, Command> {
  protected override tickRate = 10; // onTick runs ten times a second
  protected override maxPlayers = 8;
  protected override seatTimeoutMs = 60_000; // a closed tab keeps its seat for a minute

  protected initialState(): State {
    const state: State = { dots: {}, pellets: {}, nextPellet: 0 };
    for (let n = 0; n < 8; n++) state.pellets[`p${state.nextPellet++}`] = somewhere();
    return state;
  }

  // Everything a client sends is untrusted. Check it here.
  protected parseCommand(raw: unknown): Command {
    const c = raw as Partial<Command> | null;
    if (c?.type !== "move" || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return reject("invalid_command");
    const clamp = (n: number) => Math.max(3, Math.min(SIZE - 3, n));
    return { type: "move", x: clamp(c.x!), y: clamp(c.y!) };
  }

  protected override onJoin(player: Player): void {
    const at = somewhere();
    this.state.dots[player.id] = { ...at, tx: at.x, ty: at.y, score: 0 };
  }

  protected override onLeave(player: Player): void {
    delete this.state.dots[player.id];
  }

  // A command only sets a target. The simulation does the moving.
  protected onCommand(player: Player, command: Command): void {
    const dot = this.state.dots[player.id];
    if (!dot) return reject("not_playing");
    dot.tx = command.x;
    dot.ty = command.y;
  }

  protected override onTick(dt: number): void {
    const { dots, pellets } = this.state;
    for (const dot of Object.values(dots)) {
      const distance = Math.hypot(dot.tx - dot.x, dot.ty - dot.y);
      const step = Math.min(distance, SPEED * dt);
      if (step > 0) {
        dot.x = round(dot.x + ((dot.tx - dot.x) / distance) * step);
        dot.y = round(dot.y + ((dot.ty - dot.y) / distance) * step);
      }
      for (const [id, pellet] of Object.entries(pellets)) {
        if (!near(dot, pellet, 4)) continue;
        delete pellets[id];
        pellets[`p${this.state.nextPellet++}`] = somewhere();
        dot.score += 1;
      }
    }
  }

  // Each player is sent only what is within sight of their own dot.
  protected override view(player: Player) {
    const me = this.state.dots[player.id];
    if (!me) return { me: null, others: {}, pellets: {} };
    const within = <T extends Point>(things: Record<string, T>) =>
      Object.fromEntries(Object.entries(things).filter(([id, thing]) => id !== player.id && near(me, thing, SIGHT)));
    return { me, others: within(this.state.dots), pellets: within(this.state.pellets) };
  }
}
