# Godot and Unity

Tickflare has a client for Godot and one for Unity. Both do what [`RoomClient`](./client) does in a browser: they connect, keep the room's state up to date as patches arrive, send commands and say how the room answered, reconnect when the connection drops, and follow a player the room [hands to another room](./worlds).

They live in the repository, under [`clients`](https://github.com/Giamme/tickflare/tree/main/clients), and neither has dependencies.

| | Godot | Unity |
| --- | --- | --- |
| Language | GDScript, Godot 4 | C# 9, Unity 2021.3 and later |
| Install | Copy `clients/godot/addons/tickflare` into your `addons` folder | Package Manager, **Add package from git URL**: `https://github.com/Giamme/tickflare.git?path=clients/unity` |
| The room | `TickflareRoom`, a node | `TickflareRoom`, a plain class; `TickflareRunner` puts one on a GameObject |
| The state | Dictionaries, arrays, strings, floats, booleans, null | `Dictionary<string, object>`, `List<object>`, `string`, `double`, `bool`, `null` |
| Patches | Binary, unless you turn it off | Binary, unless you turn it off |
| Tested | In Godot 4.5, in CI | On .NET, compiled as Unity compiles it, in CI |

## Godot

```gdscript
extends Node2D

var room := TickflareRoom.new()

func _ready() -> void:
	add_child(room)
	room.state_changed.connect(_on_state)
	room.open("wss://my-game.example/rooms/lobby?token=" + token)

func _on_state(state: Dictionary) -> void:
	for id in state.units:
		draw_unit(id, state.units[id])

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("fire"):
		var result := await room.send({"type": "fire"})
		if not result.ok:
			print("refused: ", result.reason)
```

The room does its work in `_process`, so it has to be in the scene tree. `send` is awaited for the room's answer: `{"ok": true}` once the room has applied the command, by which time `state` shows the result, or `{"ok": false, "reason": …}`.

## Unity

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

`TickflareRunner` calls `room.Update()` every frame, which is where frames are read, the state changes and the events are raised: all on Unity's main thread. A command can be a dictionary, or JSON you have already, as from `JsonUtility.ToJson`, with `SendJsonAsync`.

A **WebGL** build has no `ClientWebSocket`, which is what the client talks through elsewhere. There the room uses `TickflareBrowserSocket` by itself, a socket on the browser's WebSocket that `room.Update()` reads from. It has not been run in a WebGL build yet. `room.SocketFactory` takes any other `ITickflareSocket`; the interface is four methods.

## What both have

| Godot | Unity | |
| --- | --- | --- |
| `open(url)`, `close()` | `Open(url)`, `Close()` | Connect, and stay connected until closed. Closing keeps the seat. |
| `send(command)` | `SendAsync(command)`, `SendJsonAsync(json)` | A command, and the room's answer to it. |
| `leave()` | `LeaveAsync()` | Give up the seat. |
| `state` | `State` | The room's state as this player sees it. |
| `players`, `you` | `Players`, `You` | Everyone with a seat, and this player's id. |
| `tick`, `tick_rate`, `seq` | `Tick`, `TickRate`, `Seq` | Where the room's simulation is. |
| `unconfirmed` | `Unconfirmed` | Commands sent that the state does not show yet. |
| `status` | `Status` | Connecting, open or closed. |
| `token_provider` | `TokenProvider` | A fresh [join token](./identity) for every attempt to connect. |
| `state_changed`, `players_changed`, `message_received`, `status_changed`, `moved` | `StateChanged`, `PlayersChanged`, `MessageReceived`, `StatusChanged`, `Moved` | Signals in Godot, events in Unity. |

## What differs from the browser client

**Numbers are floats.** Both engines read every JSON number as a floating-point one, so a round or a count arrives as `3.0`. Convert where you need a whole number.

**The state is changed in place.** `RoomClient` makes a new object for every part of the state that changed, which is what lets a web framework see what to draw again. These clients write into the dictionaries they have, which makes no garbage for the engine to collect. Keep no reference to a part of the state that you expect to stay as it was.

**Patches are binary.** Neither engine's WebSocket compresses, and JSON patches that are not compressed are about three times the size of [binary ones](../reference/protocol#binary-patches). So these clients ask for binary. Turn it off, with `binary = false` or `Binary = false` before opening, to read the frames in a network capture, or for a room of many hundreds of players who each have a view of their own: there, binary patches cost the room [more than JSON](./limits#the-same-rooms-on-cloudflare).

## Smoothing and prediction

Both clients have the browser client's [`Interpolator`](./state-sync#smoothing-on-the-client) and [`Predictor`](./state-sync#showing-a-player-s-own-moves-at-once), and behave as they do: the three are checked against the same cases.

`TickflareInterpolator` glides each moving thing from where it is drawn to its latest position, over one tick:

```gdscript
var glide := TickflareInterpolator.new(1000.0 / room.tick_rate, ["x", "y"])
room.state_changed.connect(func(state): glide.update(state.units))

func _process(_delta: float) -> void:
	var shown = glide.at(id)  # {"x": …, "y": …}, or null
```

```csharp
var glide = new TickflareInterpolator(1000 / room.TickRate, "x", "y");
room.StateChanged += state => glide.Update((Dictionary<string, object>)((Dictionary<string, object>)state)["units"]);
// in Update():
if (glide.TryGet(id, out var shown)) transform.position = new Vector3((float)shown["x"], 0, (float)shown["y"]);
```

`TickflarePredictor` shows a player their own commands at once. `apply` is what the room's `onCommand` does for one player, and changes the state in place; `tick`, optional, is what its `onTick` does to what this player controls. Send through the predictor, and draw the player's own units from its `state`:

```gdscript
var predicted: TickflarePredictor

func _ready() -> void:
	predicted = TickflarePredictor.new(room, _apply, _step)

func _apply(state: Dictionary, command: Dictionary, you: String) -> void:
	if command.type == "move":
		state.units[you].target = command.to

func _step(state: Dictionary, you: String) -> void:
	step_toward_target(state.units[you])

func move_to(x: float) -> void:
	var result := await predicted.send({"type": "move", "to": x})

func _process(_delta: float) -> void:
	draw_own(predicted.state.units[room.you])
```

```csharp
var predicted = new TickflarePredictor(room,
    (state, command, you) => { /* what onCommand does for this player */ },
    (state, you) => { /* what onTick does to this player's units */ });
await predicted.SendAsync(new Dictionary<string, object> { ["type"] = "move", ["to"] = 5.0 });
Draw(predicted.State);
```

One difference from the browser: the browser's predictor never touches the room's state and makes new objects only for what it changes. These clients change their state in place, so the predictor works on a copy of the room's state, made again when a frame arrives or a command is sent or answered, not on every drawn frame. For a large state, predict a part of it: give the predictor something room-like whose `state` is that part (in Unity, an `ITickflareRoomView`).

## What they do not have yet

**Lockstep.** A lockstep client runs the game's simulation itself, and every client has to compute exactly the same thing. Between engines that is out of reach: GDScript, C# and JavaScript write numbers as text differently, and the room compares hashes as text. Within one engine it is possible, if the simulation keeps to integer arithmetic and away from the engine's physics, which is not deterministic across machines, and if the game hashes its own state. Neither client has it yet; a game in Godot or Unity uses event mode or state sync.

**Matchmaking and accounts** are HTTP and one short-lived WebSocket, and have no helper in these clients: the [matchmaking](./matchmaking) and [accounts](./accounts) pages say what to send.

**Unity in the editor and on WebGL** are not tested: see below.

## How they are tested

Neither engine runs where Tickflare's own tests do, so each client has a job in CI. Both start a Worker with two of Tickflare's test rooms, read every frame of the [binary test vectors](https://github.com/Giamme/tickflare/blob/main/test/vectors/binary-patches.json), and then join the same room twice, once with JSON patches and once with binary ones, checking after every change that both clients hold the same state.

Both also replay the [prediction cases](https://github.com/Giamme/tickflare/blob/main/test/vectors/prediction.json): frames, acknowledgements and commands at set times, written by the browser client's `Predictor` and `Interpolator` together with what they showed at each moment. Each engine's predictor and interpolator must show the same.

The Godot client runs in Godot itself. The Unity client is compiled against .NET Standard 2.1 with C# 9, as Unity compiles it, and run on .NET: the Unity editor is not part of the test, so the `TickflareRunner` component and the install from a git URL are not covered. `TickflareBrowserSocket` is compiled as for a WebGL build, and never run.
