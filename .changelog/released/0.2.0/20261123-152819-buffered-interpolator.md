---
type: added
breaking: false
audience: user
commits: 
highlight: true
---
`BufferedInterpolator` draws what moves at the room's own pace: it keeps the last few states of each thing by tick and draws a moment a little behind the room's clock, with a delay that adapts to the jitter it measures. When updates stop it carries things on at their last speed for a few ticks, it draws a jump as one (`snap(id)` or `snapDistance`), and it turns angles the short way round. It has the same `update` and `at` as `Interpolator`, which stays for a player's own predicted moves. See [Drawing at the room's pace](https://tickflare.gridpaper.dev/guide/state-sync#drawing-at-the-room-s-pace).
