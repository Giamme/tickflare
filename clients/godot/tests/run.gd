extends SceneTree
## Tests for the Godot client. Run with a Tickflare test worker listening:
##
##   npx wrangler dev --config clients/test-server/wrangler.jsonc --port 8787
##   TICKFLARE_TEST_URL=ws://127.0.0.1:8787 godot --headless --path clients/godot --script res://tests/run.gd
##
## Exits with 1 if anything failed. Without TICKFLARE_TEST_URL, only the
## tests that need no room are run.

const Room = preload("res://addons/tickflare/tickflare_room.gd")
const Patch = preload("res://addons/tickflare/tickflare_patch.gd")
const BinaryReader = preload("res://addons/tickflare/tickflare_binary.gd")

var _failures: Array[String] = []
var _checks := 0
var _rooms := 0


func _initialize() -> void:
	_run()


func _run() -> void:
	_test_patches()
	_test_vectors()
	_test_bad_frames()
	_test_urls()
	var server := OS.get_environment("TICKFLARE_TEST_URL")
	if server == "":
		print("TICKFLARE_TEST_URL is not set: the tests that need a room were not run")
	else:
		await _test_event_room(server)
		await _test_refusals(server)
		await _test_ticking_room(server)
		await _test_reconnect(server)
		await _test_replaced_and_leave(server)
	print("%d checks, %d failed" % [_checks, _failures.size()])
	for failure in _failures:
		print("FAILED: ", failure)
	quit(1 if not _failures.is_empty() else 0)


func _check(ok: bool, what: String) -> void:
	_checks += 1
	if not ok:
		_failures.append(what)


## Whether two values are the same as JSON: 1 and 1.0 are, and so are two
## numbers that differ by what reading a decimal can be off by.
func _same(a: Variant, b: Variant) -> bool:
	var kind_a := typeof(a)
	var kind_b := typeof(b)
	var number_a := kind_a == TYPE_INT or kind_a == TYPE_FLOAT
	var number_b := kind_b == TYPE_INT or kind_b == TYPE_FLOAT
	if number_a and number_b:
		var x := float(a)
		var y := float(b)
		return x == y or absf(x - y) <= 1e-12 * maxf(absf(x), absf(y))
	if kind_a == TYPE_DICTIONARY and kind_b == TYPE_DICTIONARY:
		if a.size() != b.size():
			return false
		for key: Variant in a:
			if not b.has(key) or not _same(a[key], b[key]):
				return false
		return true
	if kind_a == TYPE_ARRAY and kind_b == TYPE_ARRAY:
		if a.size() != b.size():
			return false
		for index: int in a.size():
			if not _same(a[index], b[index]):
				return false
		return true
	return kind_a == kind_b and a == b


func _check_same(got: Variant, expected: Variant, what: String) -> void:
	_checks += 1
	if not _same(got, expected):
		_failures.append("%s: got %s, expected %s" % [what, JSON.stringify(got), JSON.stringify(expected)])


func _test_patches() -> void:
	var state: Variant = JSON.parse_string('{"units":{"a":{"x":1,"y":2},"b":{"x":5}},"order":["a","b"],"round":1}')
	state = Patch.apply(state, JSON.parse_string('{"units":{"a":{"x":[9]},"b":0,"c":[{"x":0}]},"round":[2],"order":[{"1":["c"],"2":["d"]},3]}'))
	_check_same(state, JSON.parse_string('{"units":{"a":{"x":9,"y":2},"c":{"x":0}},"order":["a","c","d"],"round":2}'), "a patch with sets, a delete, a nested patch and an array patch")
	state = Patch.apply(state, JSON.parse_string('{"order":[{},1],"grid":[[[1,2],[3,4]]]}'))
	state = Patch.apply(state, JSON.parse_string('{"grid":[{"1":[{"0":[7]},2]},2]}'))
	_check_same(state["order"], ["a"], "an array made shorter")
	_check_same(state["grid"], [[1, 2], [7, 4]], "an array patched inside an array")
	# Indexes that are not indexes are ignored, and nothing lands past the new length.
	state = Patch.apply(state, JSON.parse_string('{"order":[{"01":["x"],"-1":["x"],"5":["x"],"1":["b"]},2]}'))
	_check_same(state["order"], ["a", "b"], "an array patch with keys that are not indexes")
	_check_same(Patch.apply(null, {"a": [1.0]}), {"a": 1.0}, "a patch applied to nothing")


func _test_vectors() -> void:
	var path := ProjectSettings.globalize_path("res://").path_join("../../test/vectors/binary-patches.json").simplify_path()
	var file := FileAccess.open(path, FileAccess.READ)
	_check(file != null, "the test vectors can be opened at %s" % path)
	if file == null:
		return
	var vectors: Array = JSON.parse_string(file.get_as_text())
	_check(vectors.size() >= 10, "there are at least ten test vectors")
	for vector: Dictionary in vectors:
		var reader := BinaryReader.new()
		# Keys of a table the room has since started again: the frame says to forget them.
		for stale: int in int(vector.get("keysOfAnEarlierTable", 0)):
			reader.keys.append("stale%d" % stale)
		var index := 0
		for step: Dictionary in vector["frames"]:
			var what := "vector '%s', frame %d" % [vector["name"], index]
			var frame: Variant = reader.decode(str(step["hex"]).hex_decode())
			_check(frame != null, "%s is read (%s)" % [what, reader.error])
			if frame != null:
				_check_same(frame, step["frame"], what)
				_check_same(reader.keys, step["keys"], what + ", keys")
			index += 1


func _test_bad_frames() -> void:
	# seq 20, tick 20, the keys a and b, and {"a": [1], "b": [2]}.
	var good := "b1041414020161016202010301020302".hex_decode()
	var reader := BinaryReader.new()
	_check(reader.decode(good) != null, "a good frame is read")
	for length in good.size():
		var cut := BinaryReader.new()
		_check(cut.decode(good.slice(0, length)) == null and cut.error != "", "a frame cut at %d bytes is refused" % length)
	var longer := good.duplicate()
	longer.append(0)
	_check(BinaryReader.new().decode(longer) == null, "a frame with a byte too many is refused")
	_check(BinaryReader.new().decode("7b041414020161016202010301020302".hex_decode()) == null, "bytes that do not start as a frame are refused")
	_check(BinaryReader.new().decode("b10400000001050308".hex_decode()) == null, "a key that was never defined is refused")
	_check(BinaryReader.new().decode("b104000001016101013f".hex_decode()) == null, "a kind of value from a later version is refused")


func _test_urls() -> void:
	_check_same(Room._with_param("ws://h/rooms/r", "v", "2"), "ws://h/rooms/r?v=2", "a parameter added to a URL without a query")
	_check_same(Room._with_param("ws://h/rooms/r?token=old&lang=it", "token", "a b"), "ws://h/rooms/r?lang=it&token=a%20b", "a parameter replaced")
	_check_same(Room._with_room("wss://h/rooms/old?token=t", "new_1"), "wss://h/rooms/new_1?token=t", "the room changed in a URL")


func _fresh_room() -> String:
	_rooms += 1
	return "godot-%d-%d" % [int(Time.get_unix_time_from_system() * 1000.0), _rooms]


func _join(url: String, in_binary := true) -> Node:
	var room: Node = Room.new()
	room.binary = in_binary
	root.add_child(room)
	room.open(url)
	return room


## Waits until [param condition] holds, for at most [param seconds].
func _until(condition: Callable, what: String, seconds := 5.0) -> bool:
	var deadline := Time.get_ticks_msec() + int(seconds * 1000.0)
	while not condition.call():
		if Time.get_ticks_msec() > deadline:
			_checks += 1
			_failures.append("timed out waiting for " + what)
			return false
		await process_frame
	return true


func _test_event_room(server: String) -> void:
	var room_name := _fresh_room()
	var plain := _join("%s/shapes/%s?player=p1" % [server, room_name], false)
	var packed := _join("%s/shapes/%s?player=p2" % [server, room_name], true)
	var welcomed: bool = await _until(func() -> bool: return plain.status == "open" and packed.status == "open", "two clients to be welcomed")
	if not welcomed:
		return
	_check(plain.you == "p1" and packed.you == "p2", "each client is told who it is")
	_check(plain.protocol == 2 and packed.protocol == 2, "the room speaks version 2 to both")
	await _until(func() -> bool: return packed.players.size() == 2 and plain.players.size() == 2, "both to hear of the other")
	_check_same(packed.state, plain.state, "both are welcomed with the same state")
	_check_same(plain.state["order"], ["a", "b"], "the state is the room's")

	var seen := [0]
	packed.state_changed.connect(func(_state: Variant) -> void: seen[0] += 1)
	var done: Array[String] = []
	for change: String in ["mark", "move", "spawn", "copy", "shuffle", "replace", "remove", "mark"]:
		var sender: Node = plain if done.size() % 2 == 0 else packed
		var result: Dictionary = await sender.send({"script": change})
		done.append(change)
		_check(result["ok"], "the room applied '%s'" % change)
		await _until(func() -> bool: return plain.seq == packed.seq and plain.seq >= done.size(), "both to have seen '%s'" % change)
		# Two decoders, JSON patches and binary ones, that have to end in the same place.
		_check_same(packed.state, plain.state, "the state after %s" % ", ".join(done))
	_check_same(plain.state["total"], 100, "the state the scripts lead to")
	_check_same(plain.state["order"], ["c", "y", "z"], "an array the scripts shuffled, replaced and cut")
	_check_same(packed.state["units"]["b"], {"x": 9, "tags": ["copied"]}, "a unit the scripts copied")
	_check(not plain.state["units"].has("a") and plain.state["units"].has("c"), "a unit removed and one added")
	_check(seen[0] >= 8, "state_changed fired for every change")
	_check(plain.unconfirmed.is_empty() and packed.unconfirmed.is_empty(), "nothing is left unconfirmed")
	plain.close()
	packed.close()
	_check(plain.status == "closed", "close() closes")
	plain.queue_free()
	packed.queue_free()


func _test_refusals(server: String) -> void:
	var room := _join("%s/shapes/%s?player=p1" % [server, _fresh_room()])
	var before: Dictionary = await room.send({"script": "mark"})
	_check_same(before, {"ok": false, "reason": "not_connected"}, "a command sent before the welcome")
	var welcomed: bool = await _until(func() -> bool: return room.status == "open", "a client to be welcomed")
	if not welcomed:
		return
	var total: float = room.state["total"]
	var refused: Dictionary = await room.send({"script": "no-such-script"})
	_check_same(refused, {"ok": false, "reason": "no_such_script"}, "a command the room refuses")
	_check_same(room.state["total"], total, "a refused command changes nothing")
	_check(room.unconfirmed.is_empty(), "a refused command is no longer unconfirmed")
	room.close()
	room.queue_free()


func _test_ticking_room(server: String) -> void:
	var room_name := _fresh_room()
	var plain := _join("%s/ticks/%s?player=p1" % [server, room_name], false)
	var packed := _join("%s/ticks/%s?player=p2" % [server, room_name], true)
	var welcomed: bool = await _until(func() -> bool: return plain.status == "open" and packed.status == "open", "two clients in a ticking room")
	if not welcomed:
		return
	_check(packed.tick_rate == 50.0, "the tick rate is known")
	await _until(func() -> bool: return plain.tick >= 10 and packed.tick >= 10, "ten ticks")
	var result: Dictionary = await packed.send({"type": "bump"})
	_check(result["ok"], "a command in a ticking room is applied")
	# The answer comes with the tick that shows the command.
	_check_same(packed.state["bumps"], 1, "the state shows the command by the time it is answered")
	await _until(func() -> bool: return plain.state["bumps"] == 1.0, "the other client to see it")
	var from: int = max(plain.tick, packed.tick)
	await _until(func() -> bool: return plain.tick >= from + 20 and packed.tick >= from + 20, "twenty more ticks")
	_check(packed.state["count"] > 20.0, "the simulation is followed")
	# Each player's view has their own secrets in it: compare what both see.
	_check(absf(packed.state["count"] - plain.state["count"]) <= 5.0, "both follow the same count")
	_check(packed.state["secrets"].has("p2") and not packed.state["secrets"].has("p1"), "a player sees their own view")
	plain.close()
	packed.close()
	plain.queue_free()
	packed.queue_free()


func _test_reconnect(server: String) -> void:
	var room := _join("%s/shapes/%s?player=p1" % [server, _fresh_room()])
	var welcomed: bool = await _until(func() -> bool: return room.status == "open", "a client to be welcomed")
	if not welcomed:
		return
	await room.send({"script": "mark"})
	var statuses: Array[String] = []
	room.status_changed.connect(func(status: String, _code: int, _reason: String) -> void: statuses.append(status))
	# The connection goes away under the client.
	room._drop(1006, "test")
	_check(room.status == "connecting", "a dropped connection is tried again")
	var back: bool = await _until(func() -> bool: return room.status == "open", "the client to reconnect")
	if back:
		_check_same(statuses, ["connecting", "open"], "the statuses on the way back")
		_check_same(room.state["total"], 1, "the state is there after reconnecting")
		var result: Dictionary = await room.send({"script": "mark"})
		_check(result["ok"] and room.state["total"] == 2.0, "commands work after reconnecting")
	room.close()
	room.queue_free()


func _test_replaced_and_leave(server: String) -> void:
	var room_name := _fresh_room()
	var first := _join("%s/shapes/%s?player=p1" % [server, room_name])
	var welcomed: bool = await _until(func() -> bool: return first.status == "open", "a client to be welcomed")
	if not welcomed:
		return
	var closes := []
	first.status_changed.connect(func(status: String, code: int, _reason: String) -> void: closes.append([status, code]))
	# The same player connects again: the newer connection wins, and the older one stays closed.
	var second := _join("%s/shapes/%s?player=p1" % [server, room_name])
	await _until(func() -> bool: return second.status == "open" and first.status == "closed", "the older connection to be replaced")
	_check_same(closes, [["closed", 4000]], "replaced with code 4000, and not tried again")

	var left: Dictionary = await second.leave()
	_check(left["ok"], "leave() is answered")
	await _until(func() -> bool: return second.status == "closed", "the room to close the connection of a player who left")
	first.queue_free()
	second.queue_free()
