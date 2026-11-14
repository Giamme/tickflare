using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Tickflare
{
    public enum TickflareStatus
    {
        Connecting,
        Open,
        Closed,
    }

    /// <summary>Someone with a seat in the room.</summary>
    public sealed class TickflarePlayer
    {
        public string Id;
        public bool Connected;
        /// <summary>The name the player joined with, if the game gives its players names.</summary>
        public string Name;
    }

    /// <summary>A command that was sent and that the state does not show yet.</summary>
    public sealed class TickflareSentCommand
    {
        public long Id;
        /// <summary>What was given to <see cref="TickflareRoom.SendAsync"/>, or the JSON given to SendJsonAsync.</summary>
        public object Command;
    }

    /// <summary>
    /// The room refused a command or a leave, or it was in flight when the connection dropped
    /// ("disconnected"), or there was no connection to send it on ("not_connected").
    /// </summary>
    public sealed class TickflareRejectedException : Exception
    {
        public string Reason { get; }

        public TickflareRejectedException(string reason) : base("The room refused: " + reason)
        {
            Reason = reason;
        }
    }

    /// <summary>
    /// A connection to a Tickflare room.
    /// <code>
    /// var room = new TickflareRoom();
    /// room.StateChanged += state => Draw((Dictionary&lt;string, object&gt;)state);
    /// room.Open("wss://my-game.example/rooms/lobby?token=" + token);
    /// // Every frame, on the thread the game runs on:
    /// room.Update();
    ///
    /// try { await room.SendAsync(new Dictionary&lt;string, object&gt; { ["type"] = "fire" }); }
    /// catch (TickflareRejectedException refused) { Debug.Log(refused.Reason); }
    /// </code>
    /// It keeps <see cref="State"/> up to date, reconnects by itself when the connection drops, and
    /// follows the player when the room hands them to another room.
    ///
    /// Everything happens in <see cref="Update"/>: that is where frames are read, the state changes
    /// and the events are raised. Call it, and everything else here, from one thread. The state is
    /// changed in place as patches arrive, so keep no reference to a part of it that you expect to
    /// stay as it was.
    /// </summary>
    public sealed class TickflareRoom : IDisposable
    {
        /// <summary>The version of the protocol this client speaks.</summary>
        public const int ProtocolVersion = 3;

        private const int CloseRemoved = 4003;
        private const int CloseMoved = 4004;
        private const int FatalFrom = 4000;
        private const int FatalBelow = 4100;
        private const double MaxBackoffSeconds = 5.0;

        private sealed class Connection
        {
            public ITickflareSocket Socket;
            public readonly CancellationTokenSource Cancel = new CancellationTokenSource();
            public readonly TickflareBinaryReader Reader = new TickflareBinaryReader();
            public bool Welcomed;
            public bool Unanswered;
            public double LastPing;
        }

        private struct Incoming
        {
            public Connection From;
            public TickflareSocketMessage Message;
        }

        private sealed class Pending
        {
            public readonly TaskCompletionSource<bool> Done =
                new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            public bool Leaving;
        }

        private readonly ConcurrentQueue<Incoming> _incoming = new ConcurrentQueue<Incoming>();
        private readonly Dictionary<long, Pending> _pending = new Dictionary<long, Pending>();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly Random _random = new Random();
        private List<TickflarePlayer> _players = new List<TickflarePlayer>();
        private List<TickflareSentCommand> _unconfirmed = new List<TickflareSentCommand>();
        private Connection _connection;
        private string _url = "";
        private bool _stopped = true;
        private int _attempt;
        private double _retryAt = -1;
        private long _nextId = 1;

        /// <summary>
        /// Ask the room for its patches in binary. On by default: .NET's WebSocket is not compressed
        /// here, and binary patches are a little over a third of the size. Read when connecting.
        /// </summary>
        public bool Binary { get; set; } = true;

        /// <summary>Reconnect after an unexpected close.</summary>
        public bool Reconnect { get; set; } = true;

        /// <summary>
        /// Seconds between keepalives. A connection that goes a whole interval without hearing
        /// anything is taken for dead and replaced. 0 sends none.
        /// </summary>
        public double PingInterval { get; set; } = 25.0;

        /// <summary>
        /// Called for a join token before every attempt to connect, if set, on the thread that calls
        /// <see cref="Update"/>. What it gives replaces the <c>token</c> in the URL.
        /// </summary>
        public Func<Task<string>> TokenProvider { get; set; }

        /// <summary>Makes the socket for each connection. A <see cref="TickflareWebSocket"/> unless set.</summary>
        public Func<ITickflareSocket> SocketFactory { get; set; } = () => new TickflareWebSocket();

        /// <summary>
        /// The room's state as this player sees it, as <see cref="TickflareJson"/> gives it: a
        /// <c>Dictionary&lt;string, object&gt;</c> for most games. Null until the first frame.
        /// </summary>
        public object State { get; private set; }

        /// <summary>Everyone with a seat, in join order.</summary>
        public IReadOnlyList<TickflarePlayer> Players => _players;

        /// <summary>This player's id, once connected.</summary>
        public string You { get; private set; } = "";

        public TickflareStatus Status { get; private set; } = TickflareStatus.Closed;

        /// <summary>Changes to the state so far, as the room counts them.</summary>
        public long Seq { get; private set; }

        /// <summary>Ticks the room has run.</summary>
        public long Tick { get; private set; }

        /// <summary>Ticks the room runs a second: 0 in event mode.</summary>
        public double TickRate { get; private set; }

        /// <summary>The version of the protocol the room speaks on this connection.</summary>
        public int Protocol { get; private set; } = 1;

        /// <summary>The commands sent that <see cref="State"/> does not show yet, oldest first.</summary>
        public IReadOnlyList<TickflareSentCommand> Unconfirmed => _unconfirmed;

        /// <summary>The room's state changed. The argument is <see cref="State"/>.</summary>
        public event Action<object> StateChanged;

        /// <summary>Someone joined, dropped or came back.</summary>
        public event Action<IReadOnlyList<TickflarePlayer>> PlayersChanged;

        /// <summary>The room sent this player a message with <c>send</c> or <c>broadcast</c>.</summary>
        public event Action<object> MessageReceived;

        /// <summary>
        /// The status changed. After a close, the code and the reason say why: see the close codes in
        /// the protocol reference.
        /// </summary>
        public event Action<TickflareStatus, int, string> StatusChanged;

        /// <summary>The room handed this player to another room, and the client is connecting there.</summary>
        public event Action<string> Moved;

        /// <summary>Something went wrong that the client recovers from by itself. For logs.</summary>
        public event Action<string> Warning;

        /// <summary>
        /// Connects to the room at <paramref name="url"/>, a <c>ws://</c> or <c>wss://</c> address
        /// ending in the room's id, and keeps the connection up until <see cref="Close"/>.
        /// </summary>
        public void Open(string url)
        {
            if (url == null) throw new ArgumentNullException(nameof(url));
            Close();
            _url = url;
            _stopped = false;
            _attempt = 0;
            Connect();
        }

        /// <summary>
        /// Closes the connection for good. The seat is kept, as if the game had been quit;
        /// <see cref="LeaveAsync"/> gives it up.
        /// </summary>
        public void Close()
        {
            _stopped = true;
            _retryAt = -1;
            Connection connection = _connection;
            _connection = null;
            if (connection != null) _ = LetGo(connection, "closed");
            Forget();
            SetStatus(TickflareStatus.Closed, 1000, "closed");
        }

        public void Dispose()
        {
            Close();
        }

        /// <summary>
        /// Sends a command: anything <see cref="TickflareJson.Stringify"/> can write. The task ends
        /// once the room has applied it, by which time <see cref="State"/> shows the result, or fails
        /// with a <see cref="TickflareRejectedException"/>.
        /// </summary>
        public Task SendAsync(object command)
        {
            return Request(command, TickflareJson.Stringify(command), false);
        }

        /// <summary>
        /// Sends a command that is JSON already, as from JsonUtility or another serializer.
        /// </summary>
        public Task SendJsonAsync(string commandJson)
        {
            if (commandJson == null) throw new ArgumentNullException(nameof(commandJson));
            return Request(commandJson, commandJson, false);
        }

        /// <summary>Gives up the seat. The room then closes the connection.</summary>
        public Task LeaveAsync()
        {
            return Request(null, null, true);
        }

        /// <summary>
        /// Reads what arrived, changes the state, raises the events, and reconnects when it is time
        /// to. Call it every frame.
        /// </summary>
        public void Update()
        {
            while (_incoming.TryDequeue(out Incoming incoming))
            {
                // From a connection that has been given up since.
                if (incoming.From != _connection) continue;
                if (incoming.Message.IsClose)
                {
                    _connection = null;
                    Closed(incoming.Message.CloseCode, incoming.Message.CloseReason ?? "");
                }
                else
                {
                    Received(incoming.From, incoming.Message);
                }
            }

            double now = _clock.Elapsed.TotalSeconds;
            Connection connection = _connection;
            if (connection == null)
            {
                if (_retryAt >= 0 && now >= _retryAt)
                {
                    _retryAt = -1;
                    Connect();
                }
                return;
            }
            if (!connection.Welcomed || PingInterval <= 0 || now - connection.LastPing < PingInterval) return;
            connection.LastPing = now;
            if (connection.Unanswered)
            {
                // A dead connection can look open for minutes. Do not wait to be told.
                Drop(1006, "keepalive_timeout");
            }
            else
            {
                connection.Unanswered = true;
                _ = SendQuietly(connection, "ping");
            }
        }

        private Task Request(object command, string commandJson, bool leaving)
        {
            Connection connection = _connection;
            if (connection == null || Status != TickflareStatus.Open)
            {
                return Task.FromException(new TickflareRejectedException("not_connected"));
            }
            long id = _nextId++;
            var pending = new Pending { Leaving = leaving };
            _pending[id] = pending;
            string idText = id.ToString(CultureInfo.InvariantCulture);
            string frame;
            if (leaving)
            {
                frame = "{\"t\":\"leave\",\"id\":" + idText + "}";
            }
            else
            {
                frame = "{\"t\":\"cmd\",\"id\":" + idText + ",\"data\":" + commandJson + "}";
                _unconfirmed = new List<TickflareSentCommand>(_unconfirmed) { new TickflareSentCommand { Id = id, Command = command } };
            }
            _ = SendQuietly(connection, frame);
            return pending.Done.Task;
        }

        private void Connect()
        {
            SetStatus(TickflareStatus.Connecting, 0, "");
            ITickflareSocket socket;
            try
            {
                socket = SocketFactory();
            }
            catch (Exception error)
            {
                Warn("The socket could not be made: " + error.Message);
                Closed(1006, "connect_failed");
                return;
            }
            var connection = new Connection { Socket = socket };
            _connection = connection;
            _ = Run(connection, _url, Binary);
        }

        /// <summary>One connection, from the token to the close. What it reads waits for Update.</summary>
        private async Task Run(Connection connection, string url, bool binary)
        {
            string failure = "connect_failed";
            try
            {
                Func<Task<string>> provider = TokenProvider;
                if (provider != null)
                {
                    failure = "token_failed";
                    // Called here, before the first await: on the game's own thread.
                    string token = await provider().ConfigureAwait(false);
                    if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("The token provider gave no token");
                    url = TickflareUrl.WithParam(url, "token", token);
                    failure = "connect_failed";
                }
                url = TickflareUrl.WithParam(url, "v", ProtocolVersion.ToString(CultureInfo.InvariantCulture));
                if (binary) url = TickflareUrl.WithParam(url, "patches", "b1");

                await connection.Socket.ConnectAsync(new Uri(url), connection.Cancel.Token).ConfigureAwait(false);
                failure = "";
                while (true)
                {
                    TickflareSocketMessage message =
                        await connection.Socket.ReceiveAsync(connection.Cancel.Token).ConfigureAwait(false);
                    _incoming.Enqueue(new Incoming { From = connection, Message = message });
                    if (message.IsClose) break;
                }
            }
            catch (Exception)
            {
                _incoming.Enqueue(new Incoming { From = connection, Message = TickflareSocketMessage.Closed(1006, failure) });
            }

            // Answer the room's close, if that is how it ended, and let the socket go.
            try
            {
                using (var patience = new CancellationTokenSource(2000))
                {
                    await connection.Socket.CloseAsync(1000, "", patience.Token).ConfigureAwait(false);
                }
            }
            catch (Exception)
            {
                // It was over already.
            }
            try
            {
                connection.Socket.Dispose();
            }
            catch (Exception)
            {
            }
        }

        private static async Task SendQuietly(Connection connection, string text)
        {
            try
            {
                await connection.Socket.SendAsync(text, connection.Cancel.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // The connection is over, and the loop that reads it says so.
            }
        }

        /// <summary>Says goodbye on a connection this client gives up, then stops reading it.</summary>
        private static async Task LetGo(Connection connection, string reason)
        {
            try
            {
                using (var patience = new CancellationTokenSource(2000))
                {
                    await connection.Socket.CloseAsync(1000, reason, patience.Token).ConfigureAwait(false);
                }
            }
            catch (Exception)
            {
                // It never opened, or was over already.
            }
            try
            {
                connection.Cancel.Cancel();
            }
            catch (Exception)
            {
            }
        }

        private void Received(Connection connection, TickflareSocketMessage message)
        {
            // Anything the room sends shows that the connection is alive.
            connection.Unanswered = false;
            Dictionary<string, object> frame;
            if (message.IsText)
            {
                string text = Encoding.UTF8.GetString(message.Data);
                if (text == "pong") return;
                try
                {
                    frame = TickflareJson.Parse(text) as Dictionary<string, object>;
                }
                catch (FormatException)
                {
                    return;
                }
            }
            else
            {
                try
                {
                    frame = connection.Reader.Decode(message.Data);
                }
                catch (FormatException error)
                {
                    Warn("Could not read a binary frame: " + error.Message);
                    Drop(1006, "resync");
                    return;
                }
            }
            if (frame == null) return;

            switch (Text(frame, "t"))
            {
                case "welcome":
                    // On a connection that was open already, the room came back from its last save.
                    Forget();
                    _attempt = 0;
                    connection.Welcomed = true;
                    connection.LastPing = _clock.Elapsed.TotalSeconds;
                    You = Text(frame, "you");
                    Seq = Whole(frame, "seq", 0);
                    Tick = Whole(frame, "tick", 0);
                    TickRate = frame.TryGetValue("tickRate", out object rate) && rate is double perSecond ? perSecond : 0;
                    Protocol = (int)Whole(frame, "v", 1);
                    _players = ReadPlayers(frame, "players");
                    State = Held(frame, "state");
                    SetStatus(TickflareStatus.Open, 0, "");
                    PlayersChanged?.Invoke(_players);
                    StateChanged?.Invoke(State);
                    break;
                case "state":
                {
                    long? shows = Shows(frame);
                    Seq = Whole(frame, "seq", Seq);
                    Tick = Whole(frame, "tick", Tick);
                    Shown(shows);
                    State = Held(frame, "state");
                    StateChanged?.Invoke(State);
                    ResolveUpTo(shows);
                    break;
                }
                case "patch":
                {
                    if (frame.ContainsKey("from") && Whole(frame, "from", -1) != Seq)
                    {
                        // A patch of a view this client does not hold. Start again from the whole view.
                        Warn("Out of step with the room; reconnecting");
                        Drop(1006, "resync");
                        return;
                    }
                    long? shows = Shows(frame);
                    Seq = Whole(frame, "seq", Seq);
                    Tick = Whole(frame, "tick", Tick);
                    Shown(shows);
                    if (Held(frame, "p") is Dictionary<string, object> patch) State = TickflarePatch.Apply(State, patch);
                    StateChanged?.Invoke(State);
                    ResolveUpTo(shows);
                    break;
                }
                case "presence":
                    // The whole list, or who is new or different and who is gone.
                    _players = frame.ContainsKey("players")
                        ? ReadPlayers(frame, "players")
                        : TickflarePresence.Apply(_players, ReadPlayers(frame, "set"), Held(frame, "gone") as List<object>);
                    PlayersChanged?.Invoke(_players);
                    break;
                case "ack":
                {
                    long id = Whole(frame, "id", -1);
                    // The view is of this tick even if nothing in it changed and no frame said so.
                    long tick = Whole(frame, "tick", Tick);
                    if (tick > Tick) Tick = tick;
                    Shown(id);
                    Settle(id, null);
                    break;
                }
                case "reject":
                {
                    long id = Whole(frame, "id", -1);
                    if (_unconfirmed.Exists(sent => sent.Id == id))
                    {
                        _unconfirmed = _unconfirmed.FindAll(sent => sent.Id != id);
                    }
                    Settle(id, Text(frame, "reason"));
                    break;
                }
                case "msg":
                    MessageReceived?.Invoke(Held(frame, "d"));
                    break;
                case "error":
                    Warn("The room could not read a frame: " + Text(frame, "reason"));
                    break;
            }
        }

        private static object Held(Dictionary<string, object> frame, string key)
        {
            return frame.TryGetValue(key, out object value) ? value : null;
        }

        private static string Text(Dictionary<string, object> frame, string key)
        {
            return frame.TryGetValue(key, out object value) && value is string text ? text : "";
        }

        private static long Whole(Dictionary<string, object> frame, string key, long otherwise)
        {
            return frame.TryGetValue(key, out object value) && value is double number ? (long)number : otherwise;
        }

        private static long? Shows(Dictionary<string, object> frame)
        {
            return frame.TryGetValue("c", out object value) && value is double number ? (long)number : (long?)null;
        }

        private static List<TickflarePlayer> ReadPlayers(Dictionary<string, object> frame, string key)
        {
            var players = new List<TickflarePlayer>();
            if (!(Held(frame, key) is List<object> list)) return players;
            foreach (object item in list)
            {
                if (!(item is Dictionary<string, object> player)) continue;
                players.Add(new TickflarePlayer
                {
                    Id = Text(player, "id"),
                    Connected = player.TryGetValue("connected", out object connected) && connected is bool yes && yes,
                    Name = player.TryGetValue("name", out object name) ? name as string : null,
                });
            }
            return players;
        }

        /// <summary>The state about to be set shows this player's commands up to <paramref name="id"/>.</summary>
        private void Shown(long? id)
        {
            if (!id.HasValue || _unconfirmed.Count == 0) return;
            long last = id.Value;
            if (_unconfirmed[0].Id > last) return;
            _unconfirmed = _unconfirmed.FindAll(sent => sent.Id > last);
        }

        private void ResolveUpTo(long? id)
        {
            if (!id.HasValue || _pending.Count == 0) return;
            var shown = new List<long>();
            foreach (long pending in _pending.Keys)
            {
                if (pending <= id.Value) shown.Add(pending);
            }
            foreach (long pending in shown) Settle(pending, null);
        }

        /// <summary>Ends the wait for an answer: well, or with the room's reason for refusing.</summary>
        private void Settle(long id, string refusal)
        {
            if (!_pending.TryGetValue(id, out Pending pending)) return;
            _pending.Remove(id);
            if (refusal == null) pending.Done.TrySetResult(true);
            else pending.Done.TrySetException(new TickflareRejectedException(refusal));
        }

        /// <summary>What was in flight is lost: the connection is, or the room started again.</summary>
        private void Forget()
        {
            if (_unconfirmed.Count > 0) _unconfirmed = new List<TickflareSentCommand>();
            if (_pending.Count == 0) return;
            var lost = new List<long>(_pending.Keys);
            foreach (long id in lost) Settle(id, "disconnected");
        }

        /// <summary>Gives up on the connection as it is and goes on as after any other close.</summary>
        private void Drop(int code, string reason)
        {
            Connection connection = _connection;
            _connection = null;
            if (connection != null) _ = LetGo(connection, reason);
            Closed(code, reason);
        }

        private void Closed(int code, string reason)
        {
            if (code == CloseRemoved && reason == "left")
            {
                // The room closes this way only once it has let the player go.
                var leaving = new List<long>();
                foreach (KeyValuePair<long, Pending> entry in _pending)
                {
                    if (entry.Value.Leaving) leaving.Add(entry.Key);
                }
                foreach (long id in leaving) Settle(id, null);
            }
            Forget();

            if (code == CloseMoved && reason.Length > 0 && !_stopped)
            {
                // Handed over to another room: the same address, with that room's id at the end of the path.
                _url = TickflareUrl.WithRoom(_url, reason);
                Moved?.Invoke(reason);
                if (!_stopped && _connection == null) Connect();
                return;
            }

            bool fatal = code >= FatalFrom && code < FatalBelow;
            if (_stopped || !Reconnect || fatal)
            {
                _stopped = true;
                SetStatus(TickflareStatus.Closed, code, reason);
                return;
            }
            SetStatus(TickflareStatus.Connecting, code, reason);
            double backoff = Math.Min(MaxBackoffSeconds, 0.25 * Math.Pow(2, _attempt));
            _attempt++;
            _retryAt = _clock.Elapsed.TotalSeconds + backoff / 2 + _random.NextDouble() * backoff / 2;
        }

        private void SetStatus(TickflareStatus next, int code, string reason)
        {
            if (next == Status) return;
            Status = next;
            StatusChanged?.Invoke(next, code, reason);
        }

        private void Warn(string what)
        {
            Warning?.Invoke(what);
        }
    }

    /// <summary>What a presence frame that says what changed does to the list of players.</summary>
    public static class TickflarePresence
    {
        /// <summary>
        /// A new list, in join order: without the players whose ids are in <paramref name="gone"/>,
        /// with each of <paramref name="changed"/> in place of the entry the list had for them, or
        /// at the end if it had none.
        /// </summary>
        public static List<TickflarePlayer> Apply(IReadOnlyList<TickflarePlayer> known, IReadOnlyList<TickflarePlayer> changed, IReadOnlyList<object> gone)
        {
            var byId = new Dictionary<string, TickflarePlayer>();
            foreach (TickflarePlayer player in changed) byId[player.Id] = player;
            var left = new HashSet<string>();
            if (gone != null)
            {
                foreach (object id in gone)
                {
                    if (id is string text) left.Add(text);
                }
            }
            var result = new List<TickflarePlayer>();
            foreach (TickflarePlayer player in known)
            {
                if (left.Contains(player.Id)) continue;
                if (byId.TryGetValue(player.Id, out TickflarePlayer now))
                {
                    result.Add(now);
                    byId.Remove(player.Id);
                }
                else
                {
                    result.Add(player);
                }
            }
            foreach (TickflarePlayer player in changed)
            {
                if (byId.ContainsKey(player.Id)) result.Add(player);
            }
            return result;
        }
    }

    /// <summary>Changes to a room's address.</summary>
    public static class TickflareUrl
    {
        /// <summary><paramref name="url"/> with <paramref name="key"/> set to <paramref name="value"/> in its query.</summary>
        public static string WithParam(string url, string key, string value)
        {
            int question = url.IndexOf('?');
            string path = question < 0 ? url : url.Substring(0, question);
            var kept = new List<string>();
            if (question >= 0)
            {
                foreach (string pair in url.Substring(question + 1).Split('&'))
                {
                    if (pair.Length > 0 && !pair.StartsWith(key + "=", StringComparison.Ordinal)) kept.Add(pair);
                }
            }
            kept.Add(key + "=" + Uri.EscapeDataString(value));
            return path + "?" + string.Join("&", kept);
        }

        /// <summary><paramref name="url"/> with <paramref name="roomId"/> in place of the last part of its path.</summary>
        public static string WithRoom(string url, string roomId)
        {
            int question = url.IndexOf('?');
            string path = (question < 0 ? url : url.Substring(0, question)).TrimEnd('/');
            string query = question < 0 ? "" : url.Substring(question);
            return path.Substring(0, path.LastIndexOf('/') + 1) + roomId + query;
        }
    }
}
