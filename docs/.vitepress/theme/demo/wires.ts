import type { Ref } from "vue";
import type { Who } from "./shared";

interface Flight {
  wire: Who;
  toRoom: boolean;
  leave: number;
  arrive: number;
  el: HTMLElement;
  land: () => void;
}

/**
 * The wires between each screen and the room, and the frames travelling
 * along them. A frame is an element moved by a CSS variable; when it
 * arrives, `land` runs.
 */
export function createWires(vertical: Ref<boolean>, lagMs: number) {
  const hosts: Partial<Record<Who, HTMLElement>> = {};
  let flights: Flight[] = [];

  /** Puts a frame on a wire. `label` is shown on it; without one it is a dot. */
  function send(now: number, wire: Who, toRoom: boolean, kind: string, label: string, land: () => void, lag = lagMs): void {
    const host = hosts[wire];
    // Nowhere to draw it (not mounted yet): it still arrives, on time.
    const el = document.createElement("span");
    el.className = `pulse ${kind}`;
    el.textContent = label;
    host?.append(el);
    flights.push({ wire, toRoom, leave: now, arrive: now + lag, el, land });
  }

  /** Moves every frame to where it is at `now`, and lands the ones that have arrived, in order. */
  function move(now: number): void {
    const landed = flights.filter((flight) => flight.arrive <= now).sort((a, b) => a.arrive - b.arrive);
    flights = flights.filter((flight) => flight.arrive > now);
    for (const flight of landed) {
      flight.el.remove();
      flight.land();
    }
    for (const flight of flights) {
      const progress = (now - flight.leave) / (flight.arrive - flight.leave);
      // Side by side, Ada's wire runs from her screen to the room and Grace's from the room to her
      // screen. Stacked for a phone, both run down from a screen to the room.
      const fromScreen = flight.wire === "ada" || vertical.value ? 0 : 1;
      const at = flight.toRoom ? fromScreen + (1 - 2 * fromScreen) * progress : 1 - fromScreen + (2 * fromScreen - 1) * progress;
      flight.el.style.setProperty("--at", `${(at * 100).toFixed(1)}%`);
    }
  }

  /** A connection closed: what was on its wire is lost. */
  function drop(wire: Who): void {
    for (const flight of flights) if (flight.wire === wire) flight.el.remove();
    flights = flights.filter((flight) => flight.wire !== wire);
  }

  function clear(): void {
    for (const flight of flights) flight.el.remove();
    flights = [];
  }

  return { hosts, send, move, drop, clear };
}
