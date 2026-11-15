# Tickflare for Godot

A client for [Tickflare](../../README.md) rooms, in GDScript, for Godot 4. It has no dependencies, and is tested on Godot 4.5.

It does what the browser client's `RoomClient` does: it connects, keeps the room's state up to date as patches arrive, sends commands and tells you how the room answered, reconnects when the connection drops, and follows the player when a room hands them to another. It also has the browser client's interpolation and prediction. Lockstep is not in it.

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

## Smoothing and prediction

`TickflareInterpolator` glides moving things between ticks, and `TickflarePredictor` shows a player their own commands at once. Both behave as the browser client's `Interpolator` and `Predictor` do, and are checked against the same cases.

```gdscript
var glide := TickflareInterpolator.new(1000.0 / room.tick_rate, ["x", "y"])
room.state_changed.connect(func(state): glide.update(state.units))
var shown = glide.at(id)  # in _process: {"x": …, "y": …}, or null

var predicted := TickflarePredictor.new(room, _apply, _step)  # _apply(state, command, you), _step(state, you)
var result := await predicted.send({"type": "move", "to": 5})
draw_own(predicted.state.units[room.you])  # read it when you draw
```

`_apply` does what the room's `onCommand` does for one player, and `_step`, which is optional, what its `onTick` does to what this player controls. Both change the state they are given in place. That state is a copy of the room's, made again when a frame arrives or a command is sent or answered; for a large state, give the predictor a room-like object whose `state` is the part to predict. [Godot and Unity](../../docs/guide/engines.md#smoothing-and-prediction) has more.

## Binary patches

Godot's WebSocket does not compress, so this client asks the room for [binary patches](../../docs/reference/protocol.md#binary-patches), which are a little over a third of the size of the JSON ones. Set `room.binary = false` before `open()` to get JSON, which is easier to read in a network capture. Do the same for a room of many hundreds of players who each have a view of their own: there, binary patches cost the room more than JSON ([measured](../../docs/guide/limits.md#the-same-rooms-on-cloudflare)).

## Tests

```sh
npx wrangler dev --config clients/test-server/wrangler.jsonc --port 8787
TICKFLARE_TEST_URL=ws://127.0.0.1:8787 godot --headless --path clients/godot --script res://tests/run.gd
```

The tests read every frame in Tickflare's [binary test vectors](../../test/vectors/binary-patches.json) and replay its [prediction cases](../../test/vectors/prediction.json), then join rooms on the test server twice, once with JSON patches and once with binary ones, and check that both end with the same state.
