/**
 * The server side: rooms, the gateway, join tokens, accounts, matchmaking,
 * match results and the helpers for worlds split across rooms. Runs in a
 * Cloudflare Worker.
 *
 * @packageDocumentation
 * @module tickflare
 */
export { Room, Rejection, reject, type ActOutcome } from "./room.js";
export { plain } from "./tracked.js";
export { LockstepRoom, type LockstepCommand, type LockstepState } from "./lockstep.js";
export {
  fingerprint,
  runReplay,
  seededRandom,
  stepThrough,
  type CatchUp,
  type LockstepView,
  type TurnsMessage,
  type Replay,
  type SeededRandom,
  type Simulation,
  type Snapshot,
  type TurnEntry,
} from "../lockstep.js";
export { Matchmaker } from "./matchmaker.js";
export {
  createJoinToken,
  tokenAuth,
  verifyJoinToken,
  type JoinTokenClaims,
  type TokenAuthOptions,
  type VerifiedJoinToken,
} from "./tokens.js";
export { cellOf, shardFor, type Cell } from "../world.js";
export { MATCHES_SCHEMA, recentMatches, recordMatches, type MatchRecord } from "./matches.js";
export {
  ACCOUNTS_SCHEMA,
  AccountError,
  Accounts,
  hashPassword,
  verifyPassword,
  type AccountsOptions,
  type DataPolicy,
  type Identity,
  type ImportedAccount,
  type LeaderboardEntry,
  type LeaderboardPage,
  type OwnAccount,
  type PublicProfile,
} from "./accounts.js";
export {
  locationHintFor,
  routeToMatchmaker,
  routeToRoom,
  NAME_HEADER,
  PLAYER_HEADER,
  type Authenticated,
  type MatchmakerRouteOptions,
  type RoomNamespace,
  type RouteOptions,
} from "./gateway.js";
export { applyPatch, diff, type Patch } from "../patch.js";
export {
  CloseCode,
  PROTOCOL_VERSION,
  type AckFrame,
  type ClientMessage,
  type CommandFrame,
  type ErrorFrame,
  type LeaveFrame,
  type MatchFound,
  type MatchResult,
  type MessageFrame,
  type PatchFrame,
  type Player,
  type PresenceFrame,
  type RejectFrame,
  type ServerMessage,
  type StateFrame,
  type WelcomeFrame,
} from "../protocol.js";
