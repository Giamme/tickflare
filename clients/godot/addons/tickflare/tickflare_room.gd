class_name TickflareRoom
extends Node
## A connection to a Tickflare room.
##
## Add one to the scene, connect to its signals and call [method open]:
## [codeblock]
## var room := TickflareRoom.new()
## add_child(room)
## room.state_changed.connect(func(state): draw(state))
## room.open("wss://my-game.example/rooms/lobby?token=" + token)
##
## var result = await room.send({"type": "move", "x": 10, "y": 4})
## if not result.ok:
##     print("refused: ", result.reason)
## [/codeblock]
## It keeps [member state] up to date, reconnects by itself when the
## connection drops, and follows the player when the room hands them to
## another room. The state is what JSON gives: dictionaries, arrays, strings,
## floats, booleans and null. It is changed in place as patches arrive, so
## keep no copy of it across frames that you expect to stay the same.

## The room's state changed. [param state] is [member state].
signal state_changed(state: Variant)
## Someone joined, dropped or came back. Each player is
## [code]{"id": String, "connected": bool}[/code].
signal players_changed(players: Array)
## The room sent this player a message with [code]send[/code] or
## [code]broadcast[/code].
signal message_received(data: Variant)
## [param status] is "connecting", "open" or "closed". After a close,
## [param code] and [param reason] say why: see the close codes in the
## protocol reference.
signal status_changed(status: String, code: int, reason: String)
## The room handed this player to another room, and the client is connecting
## there.
signal moved(room_id: String)

# Loaded by path, so that the client works in a project that has not been
# imported yet, where global class names are not known.
const Patch = preload("tickflare_patch.gd")
const BinaryReader = preload("tickflare_binary.gd")

## Close codes at and above this one mean that trying again will not help.
const FATAL_FROM := 4000
const FATAL_BELOW := 4100
const CLOSE_REMOVED := 4003
const CLOSE_MOVED := 4004
const MAX_BACKOFF_MSEC := 5000
## The version of the protocol this client speaks.
const PROTOCOL_VERSION := 2

## Ask the room for its patches in binary. On by default: Godot's WebSocket is
## not compressed, and binary patches are a little over a third of the size.
@export var binary := true
## Reconnect after an unexpected close.
@export var reconnect := true
## Seconds between keepalives. A connection that goes a whole interval
## without hearing anything is taken for dead and replaced. 0 sends none.
@export var ping_interval := 25.0
## The longest frame the room may send, in bytes. A whole state is one frame.
@export var max_frame_bytes := 4 * 1024 * 1024
## Called for a join token before every attempt to connect, if set. It may
## be a coroutine. What it returns replaces the [code]token[/code] in the URL.
var token_provider := Callable()

## The room's state as this player sees it. Null until the first frame.
var state: Variant = null
## Everyone with a seat, in join order.
var players: Array = []
## This player's id, once connected.
var you := ""
## "connecting", "open" or "closed".
var status := "closed"
## Changes to the state so far, as the room counts them.
var seq := 0
## Ticks the room has run, and how many it runs a second: 0 in event mode.
var tick := 0
var tick_rate := 0.0
## The version of the protocol the room speaks on this connection.
var protocol := 1
## The commands sent that [member state] does not show yet, oldest first,
## each as [code]{"id": int, "command": Variant}[/code].
var unconfirmed: Array = []

var _url := ""
var _socket: WebSocketPeer = null
var _binary: BinaryReader = null
## Connections on their way out: polled until the close has been said.
var _closing: Array[WebSocketPeer] = []
var _stopped := true
var _welcomed := false
var _attempt := 0
var _retry_at := -1
var _next_id := 1
var _pending := {}
var _since_ping := 0.0
var _unanswered := false
## Counts attempts, so that one overtaken by a newer call can tell.
var _generation := 0


## What [method send] and [method leave] wait on.
class Pending extends RefCounted:
	signal settled(ok: bool, reason: String)
	var leaving := false


## Connects to the room at [param url], a [code]ws://[/code] or
## [code]wss://[/code] address ending in the room's id, and keeps the
## connection up until [method close].
func open(url: String) -> void:
	close()
	_url = url
	_stopped = false
	_attempt = 0
	_connect()


## Closes the connection for good. The seat is kept, as if the game had been
## quit; [method leave] gives it up.
func close() -> void:
	_stopped = true
	_generation += 1
	_retry_at = -1
	if _socket != null:
		_let_go(_socket, "closed")
		_socket = null
	_forget()
	if status != "closed":
		_set_status("closed", 1000, "closed")


## Sends a command. Await it for the room's answer:
## [code]{"ok": true}[/code] once the room has applied it, by which time
## [member state] shows the result, or [code]{"ok": false, "reason": …}[/code]
## if the room refused it, there was no connection ("not_connected") or the
## connection dropped first ("disconnected").
func send(command: Variant) -> Dictionary:
	return await _request({"t": "cmd", "data": command}, command, true)


## Gives up the seat. The room then closes the connection.
func leave() -> Dictionary:
	return await _request({"t": "leave"}, null, false)


func _request(frame: Dictionary, command: Variant, is_command: bool) -> Dictionary:
	if _socket == null or status != "open":
		return {"ok": false, "reason": "not_connected"}
	var id := _next_id
	_next_id += 1
	frame["id"] = id
	var pending := Pending.new()
	pending.leaving = not is_command
	_pending[id] = pending
	if is_command:
		unconfirmed.append({"id": id, "command": command})
	_socket.send_text(JSON.stringify(frame))
	var answer: Array = await pending.settled
	return {"ok": true} if answer[0] else {"ok": false, "reason": answer[1]}


func _connect() -> void:
	_generation += 1
	var generation := _generation
	_set_status("connecting", 0, "")
	var url := _url
	if token_provider.is_valid():
		var token: Variant = await token_provider.call()
		# open() or close() may have been called while the token was on its way.
		if generation != _generation or _stopped:
			return
		if typeof(token) != TYPE_STRING or token == "":
			_closed(1006, "token_failed")
			return
		url = _with_param(url, "token", token)
	url = _with_param(url, "v", str(PROTOCOL_VERSION))
	if binary:
		url = _with_param(url, "patches", "b1")

	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = max_frame_bytes
	_socket.max_queued_packets = 4096
	_binary = BinaryReader.new()
	_welcomed = false
	_since_ping = 0.0
	_unanswered = false
	if _socket.connect_to_url(url) != OK:
		_socket = null
		_closed(1006, "connect_failed")


func _process(delta: float) -> void:
	for index in range(_closing.size() - 1, -1, -1):
		_closing[index].poll()
		if _closing[index].get_ready_state() == WebSocketPeer.STATE_CLOSED:
			_closing.remove_at(index)
	if _socket == null:
		if _retry_at >= 0 and Time.get_ticks_msec() >= _retry_at:
			_retry_at = -1
			_connect()
		return
	var socket := _socket
	socket.poll()
	var socket_state := socket.get_ready_state()
	# What arrived before a close is still read.
	while socket == _socket and socket.get_available_packet_count() > 0:
		var packet := socket.get_packet()
		_received(packet, socket.was_string_packet())
	if socket != _socket:
		return
	if socket_state == WebSocketPeer.STATE_CLOSED:
		_socket = null
		# -1 is Godot's code for a connection that ended without a close frame.
		var code := socket.get_close_code()
		_closed(code if code > 0 else 1006, socket.get_close_reason())
	elif socket_state == WebSocketPeer.STATE_OPEN and _welcomed and ping_interval > 0.0:
		_since_ping += delta
		if _since_ping >= ping_interval:
			_since_ping = 0.0
			if _unanswered:
				# A dead connection can look open for minutes. Do not wait to be told.
				_drop(1006, "keepalive_timeout")
			else:
				_unanswered = true
				socket.send_text("ping")


func _received(packet: PackedByteArray, is_text: bool) -> void:
	# Anything the room sends shows that the connection is alive.
	_unanswered = false
	var frame: Variant
	if is_text:
		var text := packet.get_string_from_utf8()
		if text == "pong":
			return
		frame = JSON.parse_string(text)
	else:
		frame = _binary.decode(packet)
		if frame == null:
			push_warning("[tickflare] could not read a binary frame: %s" % _binary.error)
			_drop(1006, "resync")
			return
	if typeof(frame) != TYPE_DICTIONARY:
		return
	match frame.get("t", ""):
		"welcome":
			# On a connection that was open already, the room came back from its last save.
			_forget()
			_attempt = 0
			_welcomed = true
			you = frame["you"]
			seq = int(frame["seq"])
			tick = int(frame["tick"])
			tick_rate = float(frame["tickRate"])
			protocol = int(frame.get("v", 1))
			players = frame["players"]
			state = frame["state"]
			_set_status("open", 0, "")
			players_changed.emit(players)
			state_changed.emit(state)
		"state":
			seq = int(frame["seq"])
			if frame.has("tick"):
				tick = int(frame["tick"])
			_shown(frame.get("c"))
			state = frame["state"]
			state_changed.emit(state)
			_resolve_up_to(frame.get("c"))
		"patch":
			if frame.has("from") and int(frame["from"]) != seq:
				# A patch of a view this client does not hold. Start again from the whole view.
				push_warning("[tickflare] out of step with the room; reconnecting")
				_drop(1006, "resync")
				return
			seq = int(frame["seq"])
			tick = int(frame["tick"])
			_shown(frame.get("c"))
			state = Patch.apply(state, frame["p"])
			state_changed.emit(state)
			_resolve_up_to(frame.get("c"))
		"presence":
			players = frame["players"]
			players_changed.emit(players)
		"ack":
			var id := int(frame["id"])
			if frame.has("tick") and int(frame["tick"]) > tick:
				tick = int(frame["tick"])
			_shown(id)
			_settle(id, true, "")
		"reject":
			var id := int(frame["id"])
			unconfirmed = unconfirmed.filter(func(sent: Dictionary) -> bool: return sent["id"] != id)
			_settle(id, false, str(frame.get("reason", "")))
		"msg":
			message_received.emit(frame.get("d"))
		"error":
			push_warning("[tickflare] the room could not read a frame: %s" % str(frame.get("reason", "")))


## The state about to be set shows this player's commands up to [param id].
func _shown(id: Variant) -> void:
	if id == null or unconfirmed.is_empty():
		return
	var last := int(id)
	unconfirmed = unconfirmed.filter(func(sent: Dictionary) -> bool: return sent["id"] > last)


func _resolve_up_to(id: Variant) -> void:
	if id == null:
		return
	var last := int(id)
	for pending_id: int in _pending.keys():
		if pending_id <= last:
			_settle(pending_id, true, "")


func _settle(id: int, ok: bool, reason: String) -> void:
	var pending: Pending = _pending.get(id)
	if pending == null:
		return
	_pending.erase(id)
	pending.settled.emit(ok, reason)


## What was in flight is lost: the connection is, or the room started again.
func _forget() -> void:
	var lost := _pending.keys()
	unconfirmed = []
	for id: int in lost:
		_settle(id, false, "disconnected")


## Gives up on the connection as it is and goes on as after any other close.
func _drop(code: int, reason: String) -> void:
	var socket := _socket
	_socket = null
	if socket != null:
		_let_go(socket, reason)
	_closed(code, reason)


## Closes [param socket], and keeps it until the room has been told.
func _let_go(socket: WebSocketPeer, reason: String) -> void:
	if socket.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		return
	socket.close(1000, reason)
	_closing.append(socket)


func _closed(code: int, reason: String) -> void:
	_welcomed = false
	if code == CLOSE_REMOVED and reason == "left":
		# The room closes this way only once it has let the player go. Its
		# answer to leave() may not have been read before the close was.
		for id: int in _pending.keys():
			if _pending[id].leaving:
				_settle(id, true, "")
	_forget()
	if code == CLOSE_MOVED and reason != "" and not _stopped:
		# Handed over to another room: the same address, with that room's id at the end of the path.
		_url = _with_room(_url, reason)
		moved.emit(reason)
		_connect()
		return
	var fatal := code >= FATAL_FROM and code < FATAL_BELOW
	if _stopped or not reconnect or fatal:
		_stopped = true
		_set_status("closed", code, reason)
		return
	_set_status("connecting", code, reason)
	var backoff: float = min(MAX_BACKOFF_MSEC, 250.0 * pow(2.0, _attempt))
	_attempt += 1
	_retry_at = Time.get_ticks_msec() + int(backoff / 2.0 + randf() * backoff / 2.0)


func _set_status(next: String, code: int, reason: String) -> void:
	if next == status:
		return
	status = next
	status_changed.emit(next, code, reason)


## [param url] with [param key] set to [param value] in its query.
static func _with_param(url: String, key: String, value: String) -> String:
	var parts := url.split("?", true, 1)
	var kept := PackedStringArray()
	if parts.size() > 1:
		for pair in parts[1].split("&", false):
			if not pair.begins_with(key + "="):
				kept.append(pair)
	kept.append(key + "=" + value.uri_encode())
	return parts[0] + "?" + "&".join(kept)


## [param url] with [param room_id] in place of the last part of its path.
static func _with_room(url: String, room_id: String) -> String:
	var parts := url.split("?", true, 1)
	var path := parts[0].trim_suffix("/")
	var cut := path.rfind("/")
	var changed := path.substr(0, cut + 1) + room_id
	return changed + ("?" + parts[1] if parts.size() > 1 else "")
