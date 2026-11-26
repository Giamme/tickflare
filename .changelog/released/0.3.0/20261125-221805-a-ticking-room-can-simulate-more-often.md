---
type: added
breaking: false
audience: user
commits: 
---
A ticking room can simulate more often than it sends. Set `patchRate` below `tickRate` (60 ticks and 20 patches a second, say) and the room runs every tick but sends each player what changed only that many times a second, in one patch for the ticks in between. What a patch costs, `view()` for every player, the comparison and the bytes, is paid that much less often. A command is acknowledged with the patch that shows it, and messages sent from `onTick` wait for it too; nothing waits when the simulation stops. `RoomClient.patchRate` says how often patches come, `BufferedInterpolator` keeps one patch more of a delay by itself, and an `Interpolator` should glide for `1000 / room.patchRate` ms. The Godot and Unity clients work with such a room but do not read the rate yet. See [Sending less often than you simulate](https://tickflare.gridpaper.dev/guide/state-sync#sending-less-often-than-you-simulate).
