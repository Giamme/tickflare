---
type: added
breaking: false
audience: user
commits: 
---
Rooms can compress for speed: `protected override compression = "fast"` asks each player's WebSocket for a 4 KB compression window instead of Cloudflare's 32 KB. Measured locally with 500 players who each see the units near them, a tick took 55 ms of the room's thread instead of 88, and frames were about 30% larger on the wire; a room of 1,000 kept up where it had fallen behind. The default is unchanged. See [Compression](https://tickflare.gridpaper.dev/guide/limits#compression).
