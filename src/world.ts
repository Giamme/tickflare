/**
 * Helpers for worlds that are too big for one room. Cut the world into
 * square cells, give each cell its own room, and hand players from room to
 * room with `movePlayer` as they cross a border.
 */

/**
 * The id of the room responsible for a position, for a world cut into square
 * cells `cellSize` units wide. Positions may be negative. The result is a
 * valid room id, e.g. `overworld_3_-2`.
 */
export function shardFor(x: number, y: number, cellSize: number, world = "world"): string {
  return `${world}_${Math.floor(x / cellSize)}_${Math.floor(y / cellSize)}`;
}

/** A cell of a world cut into squares: its column and row. */
export interface Cell {
  /** Column: 0 holds x from 0 up to `cellSize`, -1 the column before it. */
  cx: number;
  /** Row: 0 holds y from 0 up to `cellSize`, -1 the row before it. */
  cy: number;
}

/** The cell a shard id stands for, or undefined if it is not one of `world`'s. */
export function cellOf(shardId: string, world = "world"): Cell | undefined {
  const match = /^(.*)_(-?\d+)_(-?\d+)$/.exec(shardId);
  if (!match || match[1] !== world) return undefined;
  return { cx: Number(match[2]), cy: Number(match[3]) };
}
