# Tickflare for Unity

A client for [Tickflare](../../README.md) rooms, in C#, for Unity 2021.3 and later. It has no dependencies, and no part of it but one small component needs Unity: it also runs on plain .NET.

It does what the browser client's `RoomClient` does: it connects, keeps the room's state up to date as patches arrive, sends commands and tells you how the room answered, reconnects when the connection drops, and follows the player when a room hands them to another. It also has the browser client's interpolation and prediction. Lockstep is not in it.

## Install

In the Package Manager, choose **Add package from git URL** and give it:

```
https://github.com/Giamme/tickflare.git?path=clients/unity
```

Or copy the `Runtime` folder into your project's `Assets`.

## Use

```csharp
using System.Collections.Generic;
using Tickflare;
using UnityEngine;

public class Game : MonoBehaviour
{
    private TickflareRoom room;

    private void Start()
    {
        room = gameObject.AddComponent<TickflareRunner>().Room;
        room.StateChanged += state => Draw((Dictionary<string, object>)state);
        room.StatusChanged += (status, code, reason) => Debug.Log(status + " " + code + " " + reason);
        room.Open("wss://my-game.example/rooms/lobby?token=" + token);
    }

    public async void Fire()
    {
        try
        {
            await room.SendAsync(new Dictionary<string, object> { ["type"] = "fire" });
        }
        catch (TickflareRejectedException refused)
        {
            Debug.Log("refused: " + refused.Reason);
        }
    }
}
```

`TickflareRunner` is a component that calls `room.Update()` every frame and closes the connection when its object is destroyed. Without it, make a `new TickflareRoom()` and call `Update()` yourself: that is where frames are read, the state changes and the events are raised, so everything happens on the thread you call it from.

| | |
| --- | --- |
| `Open(url)` | Connects, and stays connected until `Close()`. |
| `SendAsync(command)` | Sends a command: dictionaries, lists, strings, numbers, booleans and null. The task ends once the room has applied it, by which time `State` shows the result, or fails with a `TickflareRejectedException`. |
| `SendJsonAsync(json)` | The same, for a command that is JSON already: `JsonUtility.ToJson(myCommand)`. |
| `LeaveAsync()` | Gives up the seat. `Close()` keeps it. |
| `State` | The room's state as this player sees it: `Dictionary<string, object>`, `List<object>`, `string`, `double`, `bool` and `null`. |
| `Players`, `You` | Everyone with a seat, and this player's id. |
| `Tick`, `TickRate`, `Seq` | Where the room's simulation is. |
| `Unconfirmed` | Commands sent that `State` does not show yet. |
| `Status` | `Connecting`, `Open` or `Closed`. |
| `TokenProvider` | Returns a fresh join token; called before every attempt to connect. |
| events | `StateChanged`, `PlayersChanged`, `MessageReceived`, `StatusChanged`, `Moved`, `Warning` |

Two things differ from the browser client:

- **Numbers are doubles**, as they are in JSON. `(int)(double)units["hp"]` where you need a whole number.
- **The state is changed in place.** The browser client makes a new object for every part that changed; this one writes into the dictionaries it has, which makes no garbage. Keep no reference to a part of the state that you expect to stay as it was.

## Smoothing and prediction

`TickflareInterpolator` glides moving things between ticks, and `TickflarePredictor` shows a player their own commands at once. Both behave as the browser client's `Interpolator` and `Predictor` do, and are checked against the same cases.

```csharp
var glide = new TickflareInterpolator(1000 / room.TickRate, "x", "y");
room.StateChanged += state => glide.Update((Dictionary<string, object>)((Dictionary<string, object>)state)["units"]);
if (glide.TryGet(id, out var shown)) transform.position = new Vector3((float)shown["x"], 0, (float)shown["y"]);

var predicted = new TickflarePredictor(room, Apply, Step); // Apply(state, command, you), Step(state, you)
await predicted.SendAsync(new Dictionary<string, object> { ["type"] = "move", ["to"] = 5.0 });
Draw(predicted.State); // read it when you draw
```

`Apply` does what the room's `onCommand` does for one player, and `Step`, which is optional, what its `onTick` does to what this player controls. Both change the state they are given in place. That state is a copy of the room's, made again when a frame arrives or a command is sent or answered; for a large state, give the predictor an `ITickflareRoomView` whose `State` is the part to predict. [Godot and Unity](../../docs/guide/engines.md#smoothing-and-prediction) has more.

## Binary patches

.NET's WebSocket does not compress here, so this client asks the room for [binary patches](../../docs/reference/protocol.md#binary-patches), which are a little over a third of the size of the JSON ones. Set `room.Binary = false` before `Open()` to get JSON, which is easier to read in a network capture. Do the same for a room of many hundreds of players who each have a view of their own: there, binary patches cost the room more than JSON ([measured](../../docs/guide/limits.md#the-same-rooms-on-cloudflare)).

## WebGL

The client talks through .NET's `ClientWebSocket`, which a WebGL build does not have. There it uses `TickflareBrowserSocket` instead, by itself: a socket on the browser's WebSocket, in `Runtime/Plugins/WebGL/TickflareSocket.jslib`. The browser's events wait in a queue until `room.Update()` takes them, on the main thread, so it needs no threads or timers.

**It is untested.** It is compiled as for a WebGL build in CI, and has never run in one. If it fails for you, `room.SocketFactory` takes any other `ITickflareSocket`: the interface is four methods. A browser compresses the connection, so `Binary = false` costs little there.

## Tests

```sh
npx wrangler dev --config clients/test-server/wrangler.jsonc --port 8787
TICKFLARE_TEST_URL=ws://127.0.0.1:8787 dotnet run --project clients/unity/Tests~/Tests
```

The tests compile the `Runtime` folder against .NET Standard 2.1 with C# 9, as Unity does, and run it on .NET: they read every frame in Tickflare's [binary test vectors](../../test/vectors/binary-patches.json) and replay its [prediction cases](../../test/vectors/prediction.json), then join rooms on the test server twice, once with JSON patches and once with binary ones, and check that both end with the same state. They do not run inside the Unity editor, so the `TickflareRunner` component, the package's install from a git URL and the WebGL socket are not covered by them.
