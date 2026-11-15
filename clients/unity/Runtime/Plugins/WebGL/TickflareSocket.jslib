// The browser's WebSocket, for TickflareBrowserSocket in a Unity WebGL build. Untested: see the
// Unity client's README. Events wait in a queue per socket until C# takes them, so nothing calls
// into C# from here.
mergeInto(LibraryManager.library, {
  TickflareSocketOpen: function (urlPointer) {
    var url = UTF8ToString(urlPointer);
    if (!Module.tickflareSockets) {
      Module.tickflareSockets = {};
      Module.tickflareNextSocket = 1;
    }
    var id = Module.tickflareNextSocket++;
    var entry = { events: [], socket: null };
    Module.tickflareSockets[id] = entry;
    var encoder = new TextEncoder();
    try {
      entry.socket = new WebSocket(url);
    } catch (error) {
      entry.events.push({ kind: 4, code: 1006, data: encoder.encode("") });
      return id;
    }
    entry.socket.binaryType = "arraybuffer";
    entry.socket.onopen = function () {
      entry.events.push({ kind: 1, code: 0, data: new Uint8Array(0) });
    };
    entry.socket.onmessage = function (event) {
      if (typeof event.data === "string") entry.events.push({ kind: 2, code: 0, data: encoder.encode(event.data) });
      else entry.events.push({ kind: 3, code: 0, data: new Uint8Array(event.data) });
    };
    entry.socket.onclose = function (event) {
      entry.events.push({ kind: 4, code: event.code, data: encoder.encode(event.reason || "") });
    };
    return id;
  },

  // The next event's kind (1 open, 2 text, 3 binary, 4 closed) and close code, and the length of
  // its data, or -1 if there is no event.
  TickflareSocketPeek: function (id, kindPointer, codePointer) {
    var entry = Module.tickflareSockets && Module.tickflareSockets[id];
    if (!entry || entry.events.length === 0) return -1;
    var event = entry.events[0];
    HEAP32[kindPointer >> 2] = event.kind;
    HEAP32[codePointer >> 2] = event.code;
    return event.data.length;
  },

  // Copies the next event's data into the buffer, which is at least as long, and drops the event.
  TickflareSocketTake: function (id, bufferPointer) {
    var entry = Module.tickflareSockets && Module.tickflareSockets[id];
    if (!entry || entry.events.length === 0) return;
    var event = entry.events.shift();
    HEAPU8.set(event.data, bufferPointer);
  },

  TickflareSocketSend: function (id, textPointer) {
    var entry = Module.tickflareSockets && Module.tickflareSockets[id];
    if (entry && entry.socket && entry.socket.readyState === 1) entry.socket.send(UTF8ToString(textPointer));
  },

  TickflareSocketClose: function (id, code, reasonPointer) {
    var entry = Module.tickflareSockets && Module.tickflareSockets[id];
    if (entry && entry.socket && entry.socket.readyState < 2) entry.socket.close(code, UTF8ToString(reasonPointer));
  },

  TickflareSocketFree: function (id) {
    if (Module.tickflareSockets) delete Module.tickflareSockets[id];
  },
});
