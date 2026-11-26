---
type: added
breaking: false
audience: user
commits: 
---
A lockstep desync now says whose simulations differed and where. `desync.players` in the view names the two players whose hashes differed, and `onDesync` gets them, on the server as `onDesync(turn, players)` and in `LockstepClient` as `onDesync(turn, desync)`. With a simulation that has `save`, the two clients then send the room what they had saved at that turn, and the room puts the first eight places where the two differ in `desync.differs`, as a path into what `save` returns and the two values: `units.tank.x`, `"14"` and `"14.5"`. `onDesyncExplained` runs on the server and in every client when it is known. A client with a `hash` of its own takes part with `explainDesyncs: true`. `differences(a, b)`, the comparison itself, is exported for tests of your own. See [Finding a desync](https://tickflare.gridpaper.dev/guide/lockstep#finding-a-desync).
