---
type: changed
breaking: false
audience: user
commits: 
---
`RoomClient.send()` and `leave()` wait for a connection instead of rejecting with `not_connected` at once. A command sent while the client is connecting, the first time or again, is held, shows in `unconfirmed`, and goes out when the room answers; it rejects with `not_connected` only after `keepCommandsMs` without one. A command that was in flight when the connection dropped rejects with `disconnected` only when the client could not find out what became of it, and no longer at the moment of the drop. Pass `keepCommandsMs: 0` to keep the old behaviour.
