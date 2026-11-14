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

A **WebGL** build has no `ClientWebSocket`, which is what the client talks through. Set `room.SocketFactory` to something that makes an `ITickflareSocket` on the browser's WebSocket; the interface is four methods.

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

**Patches are binary.** Neither engine's WebSocket compresses, and JSON patches that are not compressed are about three times the size of [binary ones](../reference/protocol#binary-patches). So these clients ask for binary. Turn it off, with `binary = false` or `Binary = false` before opening, to read the frames in a network capture.

## What they do not have yet

[Lockstep](./lockstep), [prediction](./state-sync#showing-a-player-s-own-moves-at-once) and interpolation are in the browser client only. A game in Godot or Unity can use event mode and state sync as they are, and has to smooth movement between ticks with its own code. `unconfirmed` is there for a game that predicts its own moves: it is the list of commands to apply again on top of each state the room sends.

Matchmaking and accounts are HTTP and one short-lived WebSocket, and have no helper in these clients: the [matchmaking](./matchmaking) and [accounts](./accounts) pages say what to send.

## How they are tested

Neither engine runs where Tickflare's own tests do, so each client has a job in CI. Both start a Worker with two of Tickflare's test rooms, read every frame of the [binary test vectors](https://github.com/Giamme/tickflare/blob/main/test/vectors/binary-patches.json), and then join the same room twice, once with JSON patches and once with binary ones, checking after every change that both clients hold the same state.

The Godot client runs in Godot itself. The Unity client is compiled against .NET Standard 2.1 with C# 9, as Unity compiles it, and run on .NET: the Unity editor is not part of the test, so the `TickflareRunner` component and the install from a git URL are not covered.
