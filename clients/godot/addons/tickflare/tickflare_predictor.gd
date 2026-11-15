class_name TickflarePredictor
extends RefCounted
## Shows a player the effect of their own commands at once, instead of when
## the room's answer arrives.
##
## [member state] is the room's state with this player's unconfirmed commands
## applied on top, by the [code]apply[/code] you give. When the room's state
## arrives it replaces the guess: commands the room has applied are part of
## it, commands it refused are dropped, and those still on their way are
## applied again. So a wrong guess lasts until the room's answer, and never
## longer.
## [codeblock]
## var predicted := TickflarePredictor.new(room, func(state, command, you):
##     if command.type == "move":
##         state.units[you].target = command.to)
## predicted.send({"type": "move", "to": 5})
## draw(predicted.state)
## [/codeblock]
## Send through [method send], and draw from [member state] where you drew
## from [code]room.state[/code]. With a [code]tick[/code] as well, the
## prediction runs as far ahead of the room's state as a command takes to
## show there, and walks the player's own units the way the room's simulation
## would.
##
## The prediction is made on a copy of the room's state, made again when a
## frame arrives or a command is sent or answered. For a large state, predict
## a part of it: give the predictor a room-like object whose [code]state[/code]
## is that part.

## The predicted state changed: a frame arrived, or a command was sent,
## applied or refused. With a [code]tick[/code], the prediction also moves on
## with time: read [member state] when you draw.
signal state_changed(state: Variant)

## How many of the latest frames' arrival times the room's clock is read from.
const FRAMES_KEPT := 20
## A frame this much later than the earliest is taken for a room that started
## ticking again, not for a slow network.
const RESTART_MS := 1000.0
## How many of the latest commands the lead is worked out from.
const LEADS_KEPT := 7

## The room's state as it will be once the room has applied this player's
## unconfirmed commands. Null until the room's first state arrives.
var state: Variant:
	get = _predict

## With a [code]tick[/code]: how many ticks ahead of the room's state the
## prediction runs, which is how long a command takes to show there.
## Measured from the commands sent so far; 1 before the first has come back.
var lead: int:
	get:
		return _lead

var _room: Object
var _apply: Callable
var _tick: Callable
var _now: Callable
var _sent_at := {}
var _arrivals: Array[float] = []
var _last_tick := -1
var _leads: Array[int] = []
var _lead := 1
## Counts the room's frames, since its state changes in place.
var _frames := 0
var _made_key := ""
var _made: Variant = null
var _told_key := ""


## [param room] is a [TickflareRoom], or anything with its [code]state[/code],
## [code]tick[/code], [code]tick_rate[/code], [code]you[/code],
## [code]unconfirmed[/code], [code]state_changed[/code],
## [code]command_sent[/code] and [code]send[/code]. [param apply] is
## [code]func(state, command, you)[/code] and changes [code]state[/code] in
## place, as the room's [code]onCommand[/code] does; [param tick] is
## [code]func(state, you)[/code], as its [code]onTick[/code] does for what this
## player controls. [param now] gives the time in milliseconds.
func _init(room: Object, apply: Callable, tick := Callable(), now := Callable()) -> void:
	_room = room
	_apply = apply
	_tick = tick
	_now = now
	room.state_changed.connect(_on_room_state)
	if room.state != null:
		_hear()


## Sends a command, and shows its effect at once. Await it for the room's
## answer, as [code]room.send[/code]. If the room refuses the command, its
## effect is taken back.
func send(command: Variant) -> Dictionary:
	var at: int = maxi(int(_room.tick), _room_tick())
	# The room says which id the command has before it starts waiting for the answer.
	var sent := [null]
	var note := func(id: int, _command: Variant) -> void:
		sent[0] = id
		_sent_at[id] = at
		_changed()
	_room.command_sent.connect(note, CONNECT_ONE_SHOT)
	var result: Dictionary = await _room.send(command)
	# Not sent at all, when there is no connection: then there was nothing to predict.
	if _room.command_sent.is_connected(note):
		_room.command_sent.disconnect(note)
	if sent[0] != null:
		_sent_at.erase(sent[0])
		# The room's tick is now the one that first showed the command.
		if result.get("ok", false) and _tick.is_valid() and float(_room.tick_rate) > 0.0:
			_learn(int(_room.tick) - at)
		_changed()
	return result


## Stops following the room. The room itself stays connected.
func close() -> void:
	if _room.state_changed.is_connected(_on_room_state):
		_room.state_changed.disconnect(_on_room_state)


func _on_room_state(_state: Variant) -> void:
	_frames += 1
	_hear()
	_changed()


func _predict() -> Variant:
	var base: Variant = _room.state
	var pending: Array = _room.unconfirmed
	var you: String = _room.you
	var rate: float = float(_room.tick_rate)
	var ticking := _tick.is_valid() and rate > 0.0 and base != null
	var from := 0
	var to := 0
	if ticking:
		var now_tick := _room_tick()
		# If frames have stopped coming, the state is taken to be a few ticks old at most:
		# nothing in this player's view changed in the ticks without a frame.
		from = maxi(int(_room.tick), now_tick - _most_behind())
		to = now_tick + _lead
	var ids := PackedStringArray()
	for sent: Dictionary in pending:
		ids.append("%d@%d" % [int(sent["id"]), int(_sent_at.get(int(sent["id"]), 0))])
	var key := "%d|%s|%d|%d|%d|%s" % [_frames, ",".join(ids), from, to, _lead, str(base == null)]
	if key == _made_key:
		return _made
	var predicted: Variant = base
	if base != null and (not pending.is_empty() or to > from):
		predicted = base.duplicate(true) if base is Dictionary or base is Array else base
		var next := [0]
		var apply_due := func(before: float) -> void:
			while next[0] < pending.size():
				var sent: Dictionary = pending[next[0]]
				if float(_sent_at.get(int(sent["id"]), 0) + _lead) > before:
					break
				_apply.call(predicted, sent["command"], you)
				next[0] += 1
		for at in range(from + 1, to + 1):
			apply_due.call(float(at))
			_tick.call(predicted, you)
		apply_due.call(INF)
	_made_key = key
	_made = predicted
	return predicted


func _changed() -> void:
	var predicted: Variant = _predict()
	if predicted == null or _made_key == _told_key:
		return
	_told_key = _made_key
	state_changed.emit(predicted)


## A frame arrived: note when, to tell what tick the room is at between frames.
func _hear() -> void:
	var rate: float = float(_room.tick_rate)
	if not _tick.is_valid() or rate <= 0.0 or int(_room.tick) == _last_tick:
		return
	_last_tick = int(_room.tick)
	var arrival := _time() - float(_room.tick) * 1000.0 / rate
	if not _arrivals.is_empty() and arrival - _arrivals.min() > RESTART_MS:
		_arrivals.clear()
	_arrivals.append(arrival)
	if _arrivals.size() > FRAMES_KEPT:
		_arrivals.pop_front()


## The tick the room's latest frame would be of, were one to arrive now.
## Frames are late by as much as the network holds them up, so the one that
## was held up least says when ticks happen.
func _room_tick() -> int:
	var rate: float = float(_room.tick_rate)
	if _arrivals.is_empty() or rate <= 0.0:
		return int(_room.tick)
	# A hair is added so that the frame the clock was read from is not put a tick early by rounding.
	var ticks := int(floor((_time() - _arrivals.min()) * rate / 1000.0 + 0.000001))
	return maxi(int(_room.tick), ticks)


## How many ticks without a frame are taken for a frame that is late, rather
## than for nothing having changed.
func _most_behind() -> int:
	return maxi(2, int(ceil(float(_room.tick_rate) / 4.0)))


## A command took [param ticks] ticks to show in the room's state. The lead is
## the middle of the latest few.
func _learn(ticks: int) -> void:
	_leads.append(clampi(ticks, 1, int(2.0 * float(_room.tick_rate))))
	if _leads.size() > LEADS_KEPT:
		_leads.pop_front()
	var sorted := _leads.duplicate()
	sorted.sort()
	_lead = sorted[sorted.size() / 2]


func _time() -> float:
	return float(_now.call()) if _now.is_valid() else float(Time.get_ticks_msec())
