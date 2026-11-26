---
type: added
breaking: false
audience: user
commits: 
---
A ticking room can keep the state of its last ticks and judge a command by the one its player was looking at, which is what lag compensation needs. Set `historyTicks` (12 at 60 ticks a second is 200 ms) and `stateAt(tick)` returns the state as that tick left it, or `undefined` when the room does not have it. On the client, `BufferedInterpolator.drawnTick()` says which tick is on screen, to send with the command. Keeping the ticks costs no work in a tick, only memory, and `historyTicks` is also as far back as a client can claim to have seen. See [Judging a command by what its player saw](https://tickflare.gridpaper.dev/guide/state-sync#judging-a-command-by-what-its-player-saw).
