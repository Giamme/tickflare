---
type: added
breaking: false
audience: user
commits: 
highlight: true
---
A command is no longer lost, or applied twice, when the connection drops on its way. `RoomClient` names itself when it connects and numbers its commands; the room remembers how far it got with them, in the same write as the state, and says so when the client is back (protocol version 5: `c` and `refused` in `welcome`). The client settles the commands the room handled and sends the others again, so the promise from `send()` resolves or rejects as if the connection had held, through a deploy or a restart of the room too. A command waits for at most `keepCommandsMs`, ten seconds by default. It costs no rows beyond the saves a room makes anyway, but for one when a page is loaded again while its player holds a seat. Lockstep rooms and the Godot and Unity clients do not take part yet, and a room opts out with `rememberCommands = false`. See [When the connection drops](https://tickflare.gridpaper.dev/guide/client#when-the-connection-drops).
