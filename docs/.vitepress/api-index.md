# API reference

Every export of Tickflare's two entry points, generated from the doc comments in the source.

## [`tickflare`](./tickflare/)

The server side, for your Worker.

- **Rooms:** [`Room`](./tickflare/classes/Room), [`LockstepRoom`](./tickflare/classes/LockstepRoom), [`reject`](./tickflare/functions/reject), [`Rejection`](./tickflare/classes/Rejection)
- **Gateway and identity:** [`routeToRoom`](./tickflare/functions/routeToRoom), [`routeToMatchmaker`](./tickflare/functions/routeToMatchmaker), [`tokenAuth`](./tickflare/functions/tokenAuth), [`createJoinToken`](./tickflare/functions/createJoinToken), [`verifyJoinToken`](./tickflare/functions/verifyJoinToken)
- **Accounts:** [`Accounts`](./tickflare/classes/Accounts), [`AccountError`](./tickflare/classes/AccountError)
- **Matchmaking and results:** [`Matchmaker`](./tickflare/classes/Matchmaker), [`recordMatches`](./tickflare/functions/recordMatches), [`recentMatches`](./tickflare/functions/recentMatches)
- **Worlds:** [`shardFor`](./tickflare/functions/shardFor), [`cellOf`](./tickflare/functions/cellOf)
- **Lockstep:** [`runReplay`](./tickflare/functions/runReplay), [`stepThrough`](./tickflare/functions/stepThrough), [`seededRandom`](./tickflare/functions/seededRandom), [`fingerprint`](./tickflare/functions/fingerprint)
- **Protocol:** [`ServerMessage`](./tickflare/type-aliases/ServerMessage), [`ClientMessage`](./tickflare/type-aliases/ClientMessage), [`CloseCode`](./tickflare/variables/CloseCode), [`applyPatch`](./tickflare/functions/applyPatch), [`diff`](./tickflare/functions/diff)

## [`tickflare/client`](./tickflare/client/)

The client side, for browsers and Node.

- [`RoomClient`](./tickflare/client/classes/RoomClient), [`LockstepClient`](./tickflare/client/classes/LockstepClient), [`findMatch`](./tickflare/client/functions/findMatch), [`AccountClient`](./tickflare/client/classes/AccountClient), [`Interpolator`](./tickflare/client/classes/Interpolator)
