/**
 * The prices and arithmetic behind the cost estimator on the home page and in
 * the costs guide. Published list prices in US dollars, read in November 2026;
 * the guide links each source. Change a figure here and both pages follow.
 */

export const PRICES_AS_OF = "November 2026";

/** Cloudflare, Workers Paid plan. */
export const cloudflare = {
  /** The plan's monthly base. */
  base: 5,
  /** Durable Object requests: included a month, then dollars per million. */
  requestsIncluded: 1_000_000,
  perMillionRequests: 0.15,
  /** Incoming WebSocket messages that count as one request. */
  messagesPerRequest: 20,
  /** Durable Object duration: included GB-seconds a month, then dollars per million. */
  durationIncluded: 400_000,
  perMillionGbSeconds: 12.5,
  /** Every Durable Object is billed as 128 MB while awake. */
  gb: 0.128,
  /** SQLite rows written: included a month, then dollars per million. */
  rowsWrittenIncluded: 50_000_000,
  perMillionRowsWritten: 1,
  /** Requests to the Worker in front of the rooms: included a month, then dollars per million. */
  workerRequestsIncluded: 10_000_000,
  perMillionWorkerRequests: 0.3,
};

/** What Cloudflare's free plan allows in a day. */
export const freePlan = {
  requests: 100_000,
  gbSeconds: 13_000,
  rowsWritten: 100_000,
  workerRequests: 100_000,
};

/** What a Tickflare room does that is billed. Row counts were measured with Wrangler's local runtime. */
export const room = {
  /** How long handling one move keeps a sleeping room awake. Cloudflare's own examples use half this. */
  wakeSeconds: 0.02,
  /** Rows an accepted move writes in a sleeping room: its state, and a timer set again. */
  rowsPerMove: 3,
  /** A ticking room saves every `saveIntervalMs`... */
  saveEverySeconds: 5,
  /** ...and a save is this many rows: the state and the tick counter. */
  rowsPerSave: 2,
  /** Lockstep turns a second, and the rows a turn with something in it writes: the turn, and a save. */
  turnsPerSecond: 10,
  rowsPerTurn: 3,
  /** A lockstep client reports its hash once in this many turns. */
  hashEveryTurns: 20,
  /** Requests to the Worker for a player to get into a match: an identity, the connection, the odd retry. */
  workerRequestsPerPlayer: 3,
  /** Rows written as a player takes and gives up a seat. */
  rowsPerSeat: 2,
};

export const DAYS_A_MONTH = 730 / 24;
export const SECONDS_A_MONTH = 730 * 3600;

const perGbSecond = cloudflare.perMillionGbSeconds / 1e6;
const perRequest = cloudflare.perMillionRequests / 1e6;
const perRow = cloudflare.perMillionRowsWritten / 1e6;

/** One hour awake, before anything included. */
export const roomHour = 3600 * cloudflare.gb * perGbSecond;
/** One hour of a ticking room: the hour awake, and its saves. */
export const tickingHour = roomHour + (3600 / room.saveEverySeconds) * room.rowsPerSave * perRow;
/** A million messages from players, as requests alone. */
export const millionMessages = (1e6 / cloudflare.messagesPerRequest) * perRequest;
/** A million moves in a sleeping room: the requests, the time awake to handle them, and the rows they write. */
export const millionMoves = millionMessages + 1e6 * (room.wakeSeconds * cloudflare.gb * perGbSecond + room.rowsPerMove * perRow);
/** Moves a minute in one room above which a ticking room is the cheaper way to run it. */
export const breakEvenMovesAMinute = Math.round(((tickingHour / 3600) / (millionMoves / 1e6)) * 60);

/** How a room runs: asleep between moves, or ticking for the whole match. */
export type Runs = "event" | "sync" | "lockstep";

export const runsNames: Record<Runs, string> = { event: "Event mode", sync: "State sync", lockstep: "Lockstep" };

export interface Game {
  runs: Runs;
  matchesPerDay: number;
  playersPerMatch: number;
  matchMinutes: number;
  /** Messages one player sends in a minute: moves, inputs or orders. */
  messagesPerMinute: number;
  /** The busiest hour's players over the average. */
  peakFactor: number;
  /** Players one rented server holds at the peak. It depends entirely on the game. */
  playersPerServer: number;
}

export interface Bill {
  base: number;
  awake: number;
  storage: number;
  messages: number;
  total: number;
}

export interface Option {
  name: string;
  /** Dollars a month. `high` makes it a range. */
  low: number;
  high?: number;
  /** Shown before the figure, e.g. "from". */
  prefix?: string;
  note: string;
  ours?: boolean;
}

export interface Estimate {
  /** In a month. */
  matches: number;
  gbSeconds: number;
  requests: number;
  rowsWritten: number;
  workerRequests: number;
  /** In one match. */
  secondsAwake: number;
  messagesPerMatch: number;
  rowsPerMatch: number;
  /** Messages a minute arriving in one room. */
  roomMessagesAMinute: number;
  averageOnline: number;
  peakOnline: number;
  roomsAwake: number;
  servers: number;
  bill: Bill;
  /** One more match at list price, with nothing included. */
  perMatch: number;
  perPlayerHour: number;
  /** Whether a day of this fits Cloudflare's free plan. */
  free: boolean;
  options: Option[];
}

const over = (used: number, included: number) => Math.max(0, used - included);

export function estimate(game: Game): Estimate {
  const matches = game.matchesPerDay * DAYS_A_MONTH;
  const matchSeconds = game.matchMinutes * 60;
  const moves = game.playersPerMatch * game.matchMinutes * game.messagesPerMinute;
  const ticking = game.runs !== "event";

  let secondsAwake = matchSeconds;
  let rowsPerMatch = game.playersPerMatch * room.rowsPerSeat;
  let messagesPerMatch = moves;
  if (!ticking) {
    secondsAwake = Math.min(matchSeconds, moves * room.wakeSeconds);
    rowsPerMatch += moves * room.rowsPerMove;
  } else {
    rowsPerMatch += (matchSeconds / room.saveEverySeconds) * room.rowsPerSave;
    if (game.runs === "lockstep") {
      // A turn is recorded only if something arrived in it. Orders arrive when they like, so
      // the share of turns with one in them follows from how many arrive in a turn on average.
      const perTurn = moves / (matchSeconds * room.turnsPerSecond);
      rowsPerMatch += matchSeconds * room.turnsPerSecond * (1 - Math.exp(-perTurn)) * room.rowsPerTurn;
      messagesPerMatch += (game.playersPerMatch * matchSeconds * room.turnsPerSecond) / room.hashEveryTurns;
    }
  }
  const requestsPerMatch = messagesPerMatch / cloudflare.messagesPerRequest + game.playersPerMatch;

  const gbSeconds = matches * secondsAwake * cloudflare.gb;
  const requests = matches * requestsPerMatch;
  const rowsWritten = matches * rowsPerMatch;
  const workerRequests = matches * game.playersPerMatch * room.workerRequestsPerPlayer;

  const awake = over(gbSeconds, cloudflare.durationIncluded) * perGbSecond;
  const storage = over(rowsWritten, cloudflare.rowsWrittenIncluded) * perRow;
  const messages =
    over(requests, cloudflare.requestsIncluded) * perRequest +
    (over(workerRequests, cloudflare.workerRequestsIncluded) * cloudflare.perMillionWorkerRequests) / 1e6;
  const bill: Bill = { base: cloudflare.base, awake, storage, messages, total: cloudflare.base + awake + storage + messages };

  const perMatch = secondsAwake * cloudflare.gb * perGbSecond + requestsPerMatch * perRequest + rowsPerMatch * perRow;
  const playerHours = (game.playersPerMatch * game.matchMinutes) / 60;
  const averageOnline = (game.matchesPerDay * game.playersPerMatch * game.matchMinutes) / 1440;
  const peakOnline = Math.ceil(averageOnline * game.peakFactor);
  const servers = Math.max(1, Math.ceil(peakOnline / Math.max(1, game.playersPerServer)));
  const free =
    gbSeconds / DAYS_A_MONTH <= freePlan.gbSeconds &&
    requests / DAYS_A_MONTH <= freePlan.requests &&
    rowsWritten / DAYS_A_MONTH <= freePlan.rowsWritten &&
    workerRequests / DAYS_A_MONTH <= freePlan.workerRequests;

  const many = servers > 1;
  const options: Option[] = [
    {
      name: "Tickflare on Cloudflare",
      low: bill.total,
      note: free ? "This much play also fits Cloudflare's free plan." : "The whole bill: rooms, storage, bandwidth.",
      ours: true,
    },
    {
      name: many ? `${servers} rented servers` : "A rented server",
      low: server.low * servers,
      high: server.high * servers,
      note: many
        ? `If one holds ${game.playersPerServer.toLocaleString("en-US")} players at the peak. You run them.`
        : "2 vCPU, 4 GB. You run it.",
    },
    {
      name: "Colyseus Cloud",
      low: colyseusCloud * servers,
      prefix: "from",
      note: many ? `Managed servers, from $${colyseusCloud} each.` : "A managed server.",
    },
    {
      name: "Photon Fusion",
      low: photonBill(peakOnline),
      note: peakOnline <= 100 ? "Free up to 100 players at once, for one game." : `Priced by peak players: ${peakOnline.toLocaleString("en-US")} here.`,
    },
  ];

  return {
    matches,
    gbSeconds,
    requests,
    rowsWritten,
    workerRequests,
    secondsAwake,
    messagesPerMatch,
    rowsPerMatch,
    roomMessagesAMinute: game.playersPerMatch * game.messagesPerMinute,
    averageOnline,
    peakOnline,
    roomsAwake: (matches * secondsAwake) / SECONDS_A_MONTH,
    servers,
    bill,
    perMatch,
    perPlayerHour: playerHours > 0 ? perMatch / playerHours : 0,
    free,
    options,
  };
}

/** Photon Fusion public cloud, by peak concurrent players. */
export function photonBill(peak: number): number {
  if (peak <= 100) return 0;
  if (peak <= 500) return 125;
  if (peak <= 1000) return 250;
  if (peak <= 2000) return 500;
  return Math.max(1000, peak * 0.5);
}

/** A rented 2 vCPU, 4 GB server: the cheapest we found, and a typical price at larger hosts. */
export const server = { low: 7, high: 24 };
/** Colyseus Cloud's starting price per server. */
export const colyseusCloud = 15;

export interface Preset {
  id: string;
  name: string;
  about: string;
  game: Game;
}

const assumed = { peakFactor: 3, playersPerServer: 750 };

export const presets: Preset[] = [
  {
    id: "rts",
    name: "RTS matches",
    about: "Eight players, half an hour, an order every five seconds each.",
    game: { runs: "lockstep", matchesPerDay: 500, playersPerMatch: 8, matchMinutes: 30, messagesPerMinute: 12, ...assumed },
  },
  {
    id: "cards",
    name: "Card game",
    about: "Two players, ten minutes, a move every twenty seconds each.",
    game: { runs: "event", matchesPerDay: 1000, playersPerMatch: 2, matchMinutes: 10, messagesPerMinute: 3, ...assumed },
  },
  {
    id: "arena",
    name: "Arena sessions",
    about: "Ten players for an hour, steering twice a second.",
    game: { runs: "sync", matchesPerDay: 240, playersPerMatch: 10, matchMinutes: 60, messagesPerMinute: 120, ...assumed },
  },
  {
    id: "coop",
    name: "Co-op runs",
    about: "Four players, twenty minutes, an input a second each.",
    game: { runs: "sync", matchesPerDay: 300, playersPerMatch: 4, matchMinutes: 20, messagesPerMinute: 60, ...assumed },
  },
  {
    id: "rounds",
    name: "Auto-battler",
    about: "Eight players, half an hour, two decisions a minute each; the fights play out on the screens.",
    game: { runs: "event", matchesPerDay: 500, playersPerMatch: 8, matchMinutes: 30, messagesPerMinute: 2, ...assumed },
  },
];

/** Dollars, with as many digits as the size of the amount deserves. */
export const dollars = (amount: number): string =>
  amount === 0
    ? "$0"
    : amount >= 20
      ? `$${Math.round(amount).toLocaleString("en-US")}`
      : amount >= 1
        ? `$${amount.toFixed(Number.isInteger(amount) ? 0 : 2)}`
        : `$${amount.toPrecision(2)}`;

/** A small amount in cents, for the cost of a match. */
export const cents = (amount: number): string => {
  const c = amount * 100;
  if (c >= 100) return dollars(amount);
  if (c >= 10) return `${Math.round(c)} cents`;
  if (c >= 0.95) return `${Number(c.toFixed(1))} ${Number(c.toFixed(1)) === 1 ? "cent" : "cents"}`;
  return `${Number(c.toPrecision(1))} of a cent`;
};
