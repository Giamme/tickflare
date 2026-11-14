class_name TickflarePatch
extends RefCounted
## Applies a Tickflare patch to a state made of what JSON gives: dictionaries,
## arrays, strings, numbers, booleans and null.
##
## A patch mirrors the dictionary it changes. For each key it holds one of:
## a dictionary, which is a patch of what the key holds; an array of one
## element, the key's new value; an array of two, the changes to an array and
## its new length; or 0, which deletes the key.


## Changes [param state] in place. A state that is not a dictionary is
## replaced by one, so use what is returned.
static func apply(state: Variant, patch: Dictionary) -> Variant:
	var target: Dictionary = state if typeof(state) == TYPE_DICTIONARY else {}
	for key: Variant in patch:
		var change: Variant = patch[key]
		match typeof(change):
			TYPE_DICTIONARY:
				target[key] = apply(target.get(key), change)
			TYPE_ARRAY:
				if change.size() == 2:
					target[key] = _apply_to_array(target.get(key), change)
				elif change.size() == 1:
					target[key] = change[0]
			_:
				# 0, as JSON's 0.0 or the binary format's 0: the key is deleted.
				target.erase(key)
	return target


static func _apply_to_array(base: Variant, change: Array) -> Array:
	var changes: Dictionary = change[0]
	var length := int(change[1])
	var target: Array = base if typeof(base) == TYPE_ARRAY else []
	# Elements past the new length are gone; ones the patch does not give are null.
	target.resize(length)
	for key: Variant in changes:
		var index := _index(key)
		if index < 0 or index >= length:
			continue
		var element: Variant = changes[key]
		if typeof(element) == TYPE_DICTIONARY:
			target[index] = apply(target[index], element)
		elif typeof(element) == TYPE_ARRAY and element.size() == 2:
			target[index] = _apply_to_array(target[index], element)
		elif typeof(element) == TYPE_ARRAY and element.size() == 1:
			target[index] = element[0]
	return target


## An index as a patch writes it, or -1 if the key is not one.
static func _index(key: Variant) -> int:
	if typeof(key) == TYPE_INT:
		return key
	var text := str(key)
	if not text.is_valid_int():
		return -1
	var index := text.to_int()
	return index if index >= 0 and str(index) == text else -1
