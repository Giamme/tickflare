class_name TickflareBinary
extends RefCounted
## Reads Tickflare's binary patch frames. The format is written down in the
## protocol reference, docs/reference/protocol.md in the Tickflare repository.
##
## One of these belongs to one connection: it holds the keys the room has
## defined on it. Make a new one for every connection.

const MAGIC := 0xb1
const FLAG_FROM := 1
const FLAG_SHOWS := 2
const FLAG_FORGET := 4

const TAG_NULL := 0
const TAG_FALSE := 1
const TAG_TRUE := 2
const TAG_INT := 3
const TAG_NEGATIVE_INT := 4
const TAG_TENTHS := 5
const TAG_NEGATIVE_TENTHS := 6
const TAG_HUNDREDTHS := 7
const TAG_NEGATIVE_HUNDREDTHS := 8
const TAG_FLOAT := 9
const TAG_STRING := 10
const TAG_ARRAY := 11
const TAG_OBJECT := 12
const TAG_DELETE := 13
const TAG_NESTED := 14
const TAG_ELEMENTS := 15

## The keys defined on this connection, by number.
var keys: Array[String] = []
## Why the last frame could not be read. Empty when it could.
var error := ""

var _bytes: PackedByteArray
var _at := 0


## The frame as the dictionary its JSON form would parse to:
## [code]{"t": "patch", "seq": …, "tick": …, "p": {…}}[/code], with
## [code]from[/code] and [code]c[/code] when the frame has them. Numbers are
## floats, as they are from JSON. Returns null, with [member error] set, if
## the bytes are not a frame of this format: the keys can then no longer be
## trusted, and the connection has to be made again.
func decode(bytes: PackedByteArray) -> Variant:
	_bytes = bytes
	_at = 0
	error = ""
	if _byte() != MAGIC:
		return _fail("not a binary patch frame")
	var flags := _byte()
	var frame := {"t": "patch", "seq": float(_varint()), "tick": float(_varint())}
	if flags & FLAG_FROM:
		frame["from"] = float(_varint())
	if flags & FLAG_SHOWS:
		frame["c"] = float(_varint())
	if flags & FLAG_FORGET:
		keys.clear()
	for _n in _varint():
		keys.append(_string())
		if error != "":
			return null
	frame["p"] = _patch()
	if error == "" and _at != _bytes.size():
		return _fail("the frame is longer than what it holds")
	return null if error != "" else frame


func _patch() -> Dictionary:
	var patch := {}
	for _n in _varint():
		if error != "":
			break
		var key := _key()
		patch[key] = _change()
	return patch


## What to do with one key of a dictionary or one element of an array.
func _change() -> Variant:
	var tag := _byte()
	if tag == TAG_DELETE:
		return 0.0
	if tag == TAG_NESTED:
		return _patch()
	if tag != TAG_ELEMENTS:
		return [_value(tag)]
	var length := _varint()
	var changes := {}
	for _n in _varint():
		if error != "":
			break
		var index := _varint()
		changes[str(index)] = _change()
	return [changes, float(length)]


func _key() -> String:
	var number := _varint()
	if number == 0:
		return _string()
	if number > keys.size():
		_fail("the frame uses key %d, which was never defined" % (number - 1))
		return ""
	return keys[number - 1]


func _value(tag: int) -> Variant:
	match tag:
		TAG_NULL:
			return null
		TAG_FALSE:
			return false
		TAG_TRUE:
			return true
		TAG_INT:
			return float(_varint())
		TAG_NEGATIVE_INT:
			return -float(_varint())
		TAG_TENTHS:
			return float(_varint()) / 10.0
		TAG_NEGATIVE_TENTHS:
			return -(float(_varint()) / 10.0)
		TAG_HUNDREDTHS:
			return float(_varint()) / 100.0
		TAG_NEGATIVE_HUNDREDTHS:
			return -(float(_varint()) / 100.0)
		TAG_FLOAT:
			return _double()
		TAG_STRING:
			return _string()
		TAG_ARRAY:
			var items := []
			for _n in _varint():
				if error != "":
					break
				items.append(_value(_byte()))
			return items
		TAG_OBJECT:
			var entries := {}
			for _n in _varint():
				if error != "":
					break
				var key := _key()
				entries[key] = _value(_byte())
			return entries
	_fail("the frame has a value of a kind this client does not know: %d" % tag)
	return null


func _byte() -> int:
	if _at >= _bytes.size():
		_fail("the frame ends too soon")
		return 0
	_at += 1
	return _bytes[_at - 1]


## A whole number: seven bits to a byte, the lowest first, and the top bit of
## every byte but the last set.
func _varint() -> int:
	var value := 0
	var shift := 0
	while true:
		var byte := _byte()
		if error != "":
			return 0
		value += (byte & 0x7f) << shift
		if byte < 0x80:
			break
		shift += 7
		if shift > 56:
			_fail("a number in the frame is too long")
			return 0
	return value


## Eight bytes, big-endian.
func _double() -> float:
	if _at + 8 > _bytes.size():
		_fail("the frame ends too soon")
		return 0.0
	var eight := _bytes.slice(_at, _at + 8)
	eight.reverse()
	_at += 8
	return eight.decode_double(0)


func _string() -> String:
	var length := _varint()
	if error != "":
		return ""
	if _at + length > _bytes.size():
		_fail("the frame ends too soon")
		return ""
	var text := _bytes.slice(_at, _at + length).get_string_from_utf8()
	_at += length
	return text


func _fail(why: String) -> Variant:
	if error == "":
		error = why
	return null
