# Tickflare for Godot

A client for [Tickflare](../../README.md) rooms, in GDScript, for Godot 4. It has no dependencies, and is tested on Godot 4.5.

It does what the browser client's `RoomClient` does: it connects, keeps the room's state up to date as patches arrive, sends commands and tells you how the room answered, reconnects when the connection drops, and follows the player when a room hands them to another. Lockstep, prediction and interpolation are not in it yet.

## Install

Copy `addons/tickflare` into your project's `addons` folder. There is nothing to enable.

## Use

```gdscript
extends Node2D

var room := TickflareRoom.new()

func _ready() -> void:
	add_child(room)
	room.state_changed.connect(_on_state)
	room.status_changed.connect(func(status, code, reason): print(status, " ", code, " ", reason))
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

The room has to be in the scene tree: it does its work in `_process`.

| | |
| --- | --- |
| `open(url)` | Connects, and stays connected until `close()`. |
| `send(command)` | Sends a command. Await it for `{"ok": true}`, by which time `state` shows the result, or `{"ok": false, "reason": …}`. |
| `leave()` | Gives up the seat. `close()` keeps it. |
| `state` | The room's state as this player sees it: dictionaries, arrays, strings, floats, booleans and null. |
| `players`, `you` | Everyone with a seat, as `{"id", "connected"}`, and this player's id. |
| `tick`, `tick_rate`, `seq` | Where the room's simulation is. |
| `unconfirmed` | Commands sent that `state` does not show yet. |
| `status` | `"connecting"`, `"open"` or `"closed"`. |
| `token_provider` | A `Callable` that returns a fresh join token; called before every attempt to connect. |
| signals | `state_changed(state)`, `players_changed(players)`, `message_received(data)`, `status_changed(status, code, reason)`, `moved(room_id)` |

Two things differ from the browser client:

- **Numbers are floats**, because that is what Godot's JSON gives. `int(state.round)` where you need a whole number.
- **The state is changed in place.** The browser client makes a new object for every part that changed; this one writes into the dictionaries it has. Keep no reference to a part of the state that you expect to stay as it was.

## Binary patches

Godot's WebSocket does not compress, so this client asks the room for [binary patches](../../docs/reference/protocol.md#binary-patches), which are a little over a third of the size of the JSON ones. Set `room.binary = false` before `open()` to get JSON, which is easier to read in a network capture.

## Tests

```sh
npx wrangler dev --config clients/test-server/wrangler.jsonc --port 8787
TICKFLARE_TEST_URL=ws://127.0.0.1:8787 godot --headless --path clients/godot --script res://tests/run.gd
```

The tests read every frame in Tickflare's [binary test vectors](../../test/vectors/binary-patches.json), then join rooms on the test server twice, once with JSON patches and once with binary ones, and check that both end with the same state.
