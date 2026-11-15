class_name TickflareInterpolator
extends RefCounted
## Smooths values that arrive once per tick, for drawing between ticks.
##
## State sync delivers positions 10 to 30 times a second; a screen draws 60
## or more. Each time a new value arrives for an id, the interpolator glides
## to it from wherever that id was being drawn, over [member duration_ms]
## (one tick is the usual choice). Because it always starts from what is on
## screen, a late or bunched update bends the motion instead of making it jump.
## [codeblock]
## var glide := TickflareInterpolator.new(1000.0 / room.tick_rate, ["x", "y"])
## room.state_changed.connect(func(state): glide.update(state.units))
## # in _process:
## var shown = glide.at(id)  # {"x": …, "y": …}, or null
## [/codeblock]

## How long a glide takes, in milliseconds.
var duration_ms: float
## The numeric fields smoothed.
var fields: Array

var _tracks := {}


func _init(glide_ms: float, smoothed: Array) -> void:
	duration_ms = maxf(1.0, glide_ms)
	fields = smoothed.duplicate()


## Feeds the latest values, keyed by id. Ids missing from [param targets] are
## forgotten; new ones start at their target. [param now] is in milliseconds,
## [code]Time.get_ticks_msec()[/code] unless given.
func update(targets: Dictionary, now: float = -1.0) -> void:
	var time := _time(now)
	var tracks := {}
	for id: Variant in targets:
		var target: Dictionary = targets[id]
		var to := {}
		for field: String in fields:
			to[field] = float(target.get(field, 0.0))
		var from: Variant = at(str(id), time)
		tracks[str(id)] = {"from": from if from != null else to, "to": to, "since": time}
	_tracks = tracks


## The values to draw for [param id] right now, as a dictionary of the
## smoothed fields, or null if it is not known.
func at(id: String, now: float = -1.0) -> Variant:
	var track: Variant = _tracks.get(id)
	if track == null:
		return null
	var t := clampf((_time(now) - float(track["since"])) / duration_ms, 0.0, 1.0)
	var shown := {}
	for field: String in fields:
		var from: float = track["from"][field]
		shown[field] = from + (float(track["to"][field]) - from) * t
	return shown


## Forgets everything, e.g. after moving to another room.
func clear() -> void:
	_tracks.clear()


func _time(now: float) -> float:
	return now if now >= 0.0 else float(Time.get_ticks_msec())
