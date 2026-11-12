/**
 * The prices and arithmetic behind the cost estimates on the home page and in
 * the costs guide. Published list prices in US dollars, read in November 2026;
 * the guide links each source. Change a price here and both pages follow.
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
};

export const SECONDS_A_MONTH = 730 * 3600;

/** What one room costs for an hour awake, before anything included. */
export const roomHour = (3600 * cloudflare.gb * cloudflare.perMillionGbSeconds) / 1e6;
/** What a million messages from players cost, before anything included. */
export const millionMessages = cloudflare.perMillionRequests / cloudflare.messagesPerRequest;

export interface Usage {
  /** Rooms awake, averaged over the month. */
  roomsAwake: number;
  /** Messages players send in the month. */
  messages: number;
  /** Connections opened in the month. */
  connections: number;
  /** Rows the rooms write to their storage in the month. */
  rowsWritten: number;
}

export interface Bill {
  base: number;
  duration: number;
  requests: number;
  storage: number;
  total: number;
}

const over = (used: number, included: number) => Math.max(0, used - included) / 1e6;

export function cloudflareBill(usage: Usage): Bill {
  const gbSeconds = usage.roomsAwake * SECONDS_A_MONTH * cloudflare.gb;
  const requests = usage.messages / cloudflare.messagesPerRequest + usage.connections;
  const duration = over(gbSeconds, cloudflare.durationIncluded) * cloudflare.perMillionGbSeconds;
  const requestCost = over(requests, cloudflare.requestsIncluded) * cloudflare.perMillionRequests;
  const storage = over(usage.rowsWritten, cloudflare.rowsWrittenIncluded) * cloudflare.perMillionRowsWritten;
  return { base: cloudflare.base, duration, requests: requestCost, storage, total: cloudflare.base + duration + requestCost + storage };
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

export interface Scenario {
  id: string;
  name: string;
  assumptions: string;
  usage: Usage;
  bill: Bill;
  options: Option[];
  verdict: string;
}

function scenario(input: Omit<Scenario, "bill" | "options"> & { peak: number; servers: number; cloudflareNote: string }): Scenario {
  const bill = cloudflareBill(input.usage);
  const { servers, peak } = input;
  const many = servers > 1;
  return {
    ...input,
    bill,
    options: [
      { name: "Tickflare on Cloudflare", low: Math.round(bill.total), note: input.cloudflareNote, ours: true },
      {
        name: many ? `${servers} rented servers` : "A rented server",
        low: server.low * servers,
        high: server.high * servers,
        note: many ? `If one holds ${Math.round(peak / servers)} players at the peak. You run them.` : "2 vCPU, 4 GB. You run it.",
      },
      {
        name: "Colyseus Cloud",
        low: colyseusCloud * servers,
        prefix: "from",
        note: many ? `Managed servers, from $${colyseusCloud} each.` : "A managed server.",
      },
      {
        name: "Photon Fusion",
        low: photonBill(peak),
        note: peak <= 100 ? "Free up to 100 players at once, for one game." : `Priced by peak players: ${peak.toLocaleString("en-US")} here.`,
      },
    ],
  };
}

export const scenarios: Scenario[] = [
  scenario({
    id: "turns",
    name: "Turn-based",
    assumptions: "1,000 players a day, two matches each, 30 moves a match. About 50 online at the peak.",
    // Each move wakes the room for a few hundredths of a second.
    usage: { roomsAwake: (60_000 * 30 * 0.02) / SECONDS_A_MONTH, messages: 60_000 * 30, connections: 3_000 * 30, rowsWritten: 60_000 * 30 * 4 },
    peak: 50,
    servers: 1,
    cloudflareNote: "The plan's base. Everything else is inside what it includes.",
    verdict: "Rooms sleep between moves, so the bill is the plan's base. A few hundred players a day fit Cloudflare's free plan.",
  }),
  scenario({
    id: "realtime",
    name: "Real-time",
    assumptions: "100 players online on average, 300 at the peak. Ten to a room, each sending two inputs a second.",
    usage: { roomsAwake: 10, messages: 100 * 2 * SECONDS_A_MONTH, connections: 219_000, rowsWritten: (10 * SECONDS_A_MONTH) / 5 },
    peak: 300,
    servers: 1,
    cloudflareNote: "Ten rooms awake around the clock, and their messages.",
    verdict: "For rooms that never sleep, a rented server is cheaper. Cloudflare costs more here; what it buys is nothing to run, rooms placed near their players, and a bill that falls back to $5 when nobody plays.",
  }),
  scenario({
    id: "busy",
    name: "Real-time, busy",
    assumptions: "1,000 players online on average, 3,000 at the peak. Ten to a room, each sending two inputs a second.",
    usage: { roomsAwake: 100, messages: 1000 * 2 * SECONDS_A_MONTH, connections: 2_190_000, rowsWritten: (100 * SECONDS_A_MONTH) / 5 },
    peak: 3000,
    servers: 4,
    cloudflareNote: "A hundred rooms awake around the clock, and their messages.",
    verdict: "At this size, always-on rooms cost several times what a few rented servers do, and less than a service priced by peak players. If your game is steady and busy, weigh that against running the servers yourself.",
  }),
];

export const dollars = (amount: number): string =>
  amount === 0 ? "$0" : amount >= 100 ? `$${Math.round(amount).toLocaleString("en-US")}` : amount >= 1 ? `$${amount.toFixed(amount % 1 ? 2 : 0)}` : `$${amount.toPrecision(2)}`;
