---
type: added
breaking: false
audience: user
commits: 
---
Spectators: connections that watch a room without a seat in it. Set `maxSpectators` on the room and connect with `new RoomClient(url, { spectate: true })`. A spectator is sent the room's `spectatorView()`, kept up to date like a player's view, with who is here and what the room broadcasts; they are not among `players`, no seat hook runs for them, and what they send is refused. `spectatorDelayMs` keeps them that far behind the players, in everything, so that watching is no help to someone who plays. `onSpectate(player)` decides who may watch, and a room with a `view()` of its own takes no spectators until it has a `spectatorView()`. Not for lockstep rooms, and not yet in the Godot and Unity clients. On the wire a spectator asks with `spectate=1` and is answered with a `spectating` frame in place of `welcome`; a gateway of your own should hand such a request to the room under `x-tickflare-spectator`, as `routeToRoom` does. See [Spectators](https://tickflare.gridpaper.dev/guide/spectators).
