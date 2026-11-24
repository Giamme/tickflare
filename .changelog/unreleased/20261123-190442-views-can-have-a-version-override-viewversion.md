---
type: added
breaking: false
audience: user
commits: 
---
Views can have a version: override `viewVersion(player)` to return a number or string that changes whenever that player's view would, and the room skips players whose view has the version they were last sent, without calling their `view()` or comparing anything. Measured locally with 1,000 players, a tick took a quarter of the time when nothing moved and three quarters when one unit in a hundred did; where everything moves on every tick, it saves nothing. See [Views that did not change](https://tickflare.gridpaper.dev/guide/state-and-views#views-that-did-not-change).
