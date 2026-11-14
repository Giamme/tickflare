// Tests for the Unity client, run on .NET against a Tickflare test server:
//
//   npx wrangler dev --config clients/test-server/wrangler.jsonc --port 8787
//   TICKFLARE_TEST_URL=ws://127.0.0.1:8787 dotnet run --project clients/unity/Tests~/Tests
//
// Exits with 1 if anything failed. Without TICKFLARE_TEST_URL, only the tests that need no room
// are run.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Tickflare.Tests
{
    /// <summary>What Unity's main thread is to a game: awaits come back here, between two updates.</summary>
    internal sealed class Pump : SynchronizationContext
    {
        private readonly ConcurrentQueue<KeyValuePair<SendOrPostCallback, object>> _posted =
            new ConcurrentQueue<KeyValuePair<SendOrPostCallback, object>>();

        public override void Post(SendOrPostCallback callback, object state)
        {
            _posted.Enqueue(new KeyValuePair<SendOrPostCallback, object>(callback, state));
        }

        public override void Send(SendOrPostCallback callback, object state)
        {
            callback(state);
        }

        public void Run()
        {
            for (int left = _posted.Count; left > 0; left--)
            {
                if (!_posted.TryDequeue(out KeyValuePair<SendOrPostCallback, object> posted)) return;
                posted.Key(posted.Value);
            }
        }
    }

    /// <summary>A socket that can be made to fail, and that remembers where it connected.</summary>
    internal sealed class BreakableSocket : ITickflareSocket
    {
        private readonly TickflareWebSocket _inner = new TickflareWebSocket();
        private readonly TaskCompletionSource<bool> _broken =
            new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        public string Url = "";

        public void Break()
        {
            _broken.TrySetResult(true);
        }

        public Task ConnectAsync(Uri url, CancellationToken cancel)
        {
            Url = url.ToString();
            return _inner.ConnectAsync(url, cancel);
        }

        public Task SendAsync(string text, CancellationToken cancel)
        {
            return _inner.SendAsync(text, cancel);
        }

        public async Task<TickflareSocketMessage> ReceiveAsync(CancellationToken cancel)
        {
            Task<TickflareSocketMessage> next = _inner.ReceiveAsync(cancel);
            Task first = await Task.WhenAny(next, _broken.Task).ConfigureAwait(false);
            if (first == _broken.Task)
            {
                // Whatever becomes of the read that was under way, nobody is waiting for it.
                _ = next.ContinueWith(ended => ended.Exception, TaskContinuationOptions.OnlyOnFaulted);
                throw new IOException("The connection broke");
            }
            return await next.ConfigureAwait(false);
        }

        public Task CloseAsync(int code, string reason, CancellationToken cancel)
        {
            return _inner.CloseAsync(code, reason, cancel);
        }

        public void Dispose()
        {
            _inner.Dispose();
        }
    }

    internal static class Program
    {
        private static readonly List<string> Failures = new List<string>();
        private static readonly List<TickflareRoom> Rooms = new List<TickflareRoom>();
        private static int _checks;
        private static int _roomCount;

        private static int Main()
        {
            var pump = new Pump();
            SynchronizationContext.SetSynchronizationContext(pump);
            Task tests = RunAll();
            var watch = Stopwatch.StartNew();
            while (!tests.IsCompleted)
            {
                pump.Run();
                foreach (TickflareRoom room in Rooms.ToArray()) room.Update();
                Thread.Sleep(1);
                if (watch.Elapsed.TotalSeconds > 240)
                {
                    Failures.Add("the tests did not end in four minutes");
                    break;
                }
            }
            if (tests.IsFaulted) Failures.Add("the tests stopped: " + tests.Exception.GetBaseException());

            Console.WriteLine(_checks + " checks, " + Failures.Count + " failed");
            foreach (string failure in Failures) Console.WriteLine("FAILED: " + failure);
            return Failures.Count == 0 ? 0 : 1;
        }

        private static async Task RunAll()
        {
            TestJson();
            TestPatches();
            TestVectors();
            TestBadFrames();
            TestUrls();
            string server = Environment.GetEnvironmentVariable("TICKFLARE_TEST_URL");
            if (string.IsNullOrEmpty(server))
            {
                Console.WriteLine("TICKFLARE_TEST_URL is not set: the tests that need a room were not run");
                return;
            }
            await TestEventRoom(server);
            await TestRefusals(server);
            await TestTickingRoom(server);
            await TestReconnect(server);
            await TestReplacedAndLeave(server);
        }

        // ---- Checking ----

        private static void Check(bool ok, string what)
        {
            _checks++;
            if (!ok) Failures.Add(what);
        }

        private static void CheckSame(object got, object expected, string what)
        {
            _checks++;
            if (!Same(got, expected)) Failures.Add(what + ": got " + Show(got) + ", expected " + Show(expected));
        }

        private static string Show(object value)
        {
            try
            {
                return TickflareJson.Stringify(value);
            }
            catch (ArgumentException)
            {
                return Convert.ToString(value);
            }
        }

        private static void CheckThrows<T>(Action action, string what) where T : Exception
        {
            _checks++;
            try
            {
                action();
                Failures.Add(what + ": nothing was thrown");
            }
            catch (T)
            {
            }
            catch (Exception other)
            {
                Failures.Add(what + ": threw " + other.GetType().Name + " (" + other.Message + ")");
            }
        }

        /// <summary>Whether two values are the same as JSON: 1 and 1.0 are.</summary>
        private static bool Same(object a, object b)
        {
            if (a == null || b == null) return a == null && b == null;
            if (IsNumber(a) && IsNumber(b))
            {
                double x = Convert.ToDouble(a);
                double y = Convert.ToDouble(b);
                return x == y || Math.Abs(x - y) <= 1e-12 * Math.Max(Math.Abs(x), Math.Abs(y));
            }
            if (a is Dictionary<string, object> left && b is Dictionary<string, object> right)
            {
                if (left.Count != right.Count) return false;
                foreach (KeyValuePair<string, object> entry in left)
                {
                    if (!right.TryGetValue(entry.Key, out object other) || !Same(entry.Value, other)) return false;
                }
                return true;
            }
            if (a is List<object> first && b is List<object> second)
            {
                if (first.Count != second.Count) return false;
                for (int index = 0; index < first.Count; index++)
                {
                    if (!Same(first[index], second[index])) return false;
                }
                return true;
            }
            return a.GetType() == b.GetType() && a.Equals(b);
        }

        private static bool IsNumber(object value)
        {
            return value is double || value is float || value is int || value is long;
        }

        private static object J(string json)
        {
            return TickflareJson.Parse(json);
        }

        /// <summary>What is at a path of keys in a state.</summary>
        private static object At(object value, params string[] path)
        {
            foreach (string key in path)
            {
                if (!(value is Dictionary<string, object> held) || !held.TryGetValue(key, out value)) return null;
            }
            return value;
        }

        private static List<object> StringList(IEnumerable<string> strings)
        {
            var list = new List<object>();
            foreach (string text in strings) list.Add(text);
            return list;
        }

        // ---- Without a room ----

        private static void TestJson()
        {
            object parsed = J(" { \"a\" : [1, 2.5, -3e2, \"x\\n\\u00e9\\\"\", true, false, null], \"b\": {}, \"\": [] } ");
            var expected = new Dictionary<string, object>
            {
                ["a"] = new List<object> { 1.0, 2.5, -300.0, "x\n\u00e9\"", true, false, null },
                ["b"] = new Dictionary<string, object>(),
                [""] = new List<object>(),
            };
            CheckSame(parsed, expected, "JSON is read");
            CheckSame(J(TickflareJson.Stringify(expected)), expected, "what is written reads back the same");

            var command = new Dictionary<string, object>
            {
                ["n"] = 3,
                ["f"] = 0.1f,
                ["d"] = 1.5,
                ["big"] = 1e21,
                ["whole"] = 7.0,
                ["l"] = new[] { 1, 2 },
                ["s"] = "q\"\\\n\u0001",
                ["nothing"] = null,
                ["no"] = false,
            };
            CheckSame(
                TickflareJson.Stringify(command),
                "{\"n\":3,\"f\":0.1,\"d\":1.5,\"big\":1E+21,\"whole\":7,\"l\":[1,2],\"s\":\"q\\\"\\\\\\n\\u0001\",\"nothing\":null,\"no\":false}",
                "a command is written as JSON");
            CheckSame(J("\"\\ud83c\\udfb2\""), "\ud83c\udfb2", "a character outside the basic plane");

            foreach (string bad in new[] { "", "{", "[1,]", "nul", "\"abc", "{\"a\" 1}", "1 2", "{a:1}", "[1 2]", "\"\\x\"", "-" })
            {
                CheckThrows<FormatException>(() => J(bad), "bad JSON is refused: " + bad);
            }
            CheckThrows<ArgumentException>(() => TickflareJson.Stringify(new object()), "a value that is not JSON is not written");
        }

        private static void TestPatches()
        {
            object state = J("{\"units\":{\"a\":{\"x\":1,\"y\":2},\"b\":{\"x\":5}},\"order\":[\"a\",\"b\"],\"round\":1}");
            state = Apply(state, "{\"units\":{\"a\":{\"x\":[9]},\"b\":0,\"c\":[{\"x\":0}]},\"round\":[2],\"order\":[{\"1\":[\"c\"],\"2\":[\"d\"]},3]}");
            CheckSame(
                state,
                J("{\"units\":{\"a\":{\"x\":9,\"y\":2},\"c\":{\"x\":0}},\"order\":[\"a\",\"c\",\"d\"],\"round\":2}"),
                "a patch with sets, a delete, a nested patch and an array patch");
            state = Apply(state, "{\"order\":[{},1],\"grid\":[[[1,2],[3,4]]]}");
            state = Apply(state, "{\"grid\":[{\"1\":[{\"0\":[7]},2]},2]}");
            CheckSame(At(state, "order"), J("[\"a\"]"), "an array made shorter");
            CheckSame(At(state, "grid"), J("[[1,2],[7,4]]"), "an array patched inside an array");
            // Indexes that are not indexes are ignored, and nothing lands past the new length.
            state = Apply(state, "{\"order\":[{\"01\":[\"x\"],\"-1\":[\"x\"],\"5\":[\"x\"],\"1\":[\"b\"]},2]}");
            CheckSame(At(state, "order"), J("[\"a\",\"b\"]"), "an array patch with keys that are not indexes");
            CheckSame(Apply(null, "{\"a\":[1]}"), J("{\"a\":1}"), "a patch applied to nothing");
        }

        private static object Apply(object state, string patch)
        {
            return TickflarePatch.Apply(state, (Dictionary<string, object>)J(patch));
        }

        private static string FindUp(string relative)
        {
            var folder = new DirectoryInfo(AppContext.BaseDirectory);
            while (folder != null)
            {
                string candidate = Path.Combine(folder.FullName, relative);
                if (File.Exists(candidate)) return candidate;
                folder = folder.Parent;
            }
            return null;
        }

        private static void TestVectors()
        {
            string path = FindUp(Path.Combine("test", "vectors", "binary-patches.json"));
            Check(path != null, "the test vectors are found");
            if (path == null) return;
            var vectors = (List<object>)J(File.ReadAllText(path));
            Check(vectors.Count >= 10, "there are at least ten test vectors");
            foreach (object item in vectors)
            {
                var vector = (Dictionary<string, object>)item;
                var reader = new TickflareBinaryReader();
                // Keys of a table the room has since started again: the frame says to forget them.
                if (vector.TryGetValue("keysOfAnEarlierTable", out object stale))
                {
                    for (int index = 0; index < (int)(double)stale; index++) reader.Keys.Add("stale" + index);
                }
                int number = 0;
                foreach (object each in (List<object>)vector["frames"])
                {
                    var step = (Dictionary<string, object>)each;
                    string what = "vector '" + vector["name"] + "', frame " + number++;
                    try
                    {
                        Dictionary<string, object> frame = reader.Decode(Convert.FromHexString((string)step["hex"]));
                        CheckSame(frame, step["frame"], what);
                        CheckSame(StringList(reader.Keys), step["keys"], what + ", keys");
                    }
                    catch (FormatException error)
                    {
                        Check(false, what + " is read (" + error.Message + ")");
                    }
                }
            }
        }

        private static void TestBadFrames()
        {
            // seq 20, tick 20, the keys a and b, and {"a": [1], "b": [2]}.
            byte[] good = Convert.FromHexString("b1041414020161016202010301020302");
            CheckSame(
                new TickflareBinaryReader().Decode(good),
                J("{\"t\":\"patch\",\"seq\":20,\"tick\":20,\"p\":{\"a\":[1],\"b\":[2]}}"),
                "a good frame is read");
            for (int length = 0; length < good.Length; length++)
            {
                byte[] cut = new byte[length];
                Array.Copy(good, cut, length);
                CheckThrows<FormatException>(() => new TickflareBinaryReader().Decode(cut), "a frame cut at " + length + " bytes is refused");
            }
            byte[] longer = new byte[good.Length + 1];
            Array.Copy(good, longer, good.Length);
            CheckThrows<FormatException>(() => new TickflareBinaryReader().Decode(longer), "a frame with a byte too many is refused");
            CheckThrows<FormatException>(
                () => new TickflareBinaryReader().Decode(Convert.FromHexString("7b041414020161016202010301020302")),
                "bytes that do not start as a frame are refused");
            CheckThrows<FormatException>(
                () => new TickflareBinaryReader().Decode(Convert.FromHexString("b10400000001050308")),
                "a key that was never defined is refused");
            CheckThrows<FormatException>(
                () => new TickflareBinaryReader().Decode(Convert.FromHexString("b104000001016101013f")),
                "a kind of value from a later version is refused");
            CheckThrows<FormatException>(
                () => new TickflareBinaryReader().Decode(Convert.FromHexString("b10400000102ffff00")),
                "a key that is not UTF-8 is refused");
        }

        private static void TestUrls()
        {
            CheckSame(TickflareUrl.WithParam("ws://h/rooms/r", "v", "2"), "ws://h/rooms/r?v=2", "a parameter added to a URL without a query");
            CheckSame(
                TickflareUrl.WithParam("ws://h/rooms/r?token=old&lang=it", "token", "a b"),
                "ws://h/rooms/r?lang=it&token=a%20b",
                "a parameter replaced");
            CheckSame(TickflareUrl.WithRoom("wss://h/rooms/old?token=t", "new_1"), "wss://h/rooms/new_1?token=t", "the room changed in a URL");
            CheckSame(TickflareUrl.WithRoom("wss://h/rooms/old/", "new_1"), "wss://h/rooms/new_1", "the room changed in a URL that ends in a slash");
        }

        // ---- With rooms ----

        private static string FreshRoom()
        {
            _roomCount++;
            return "unity-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "-" + _roomCount;
        }

        private static TickflareRoom Join(string url, bool binary = true)
        {
            var room = new TickflareRoom { Binary = binary };
            Rooms.Add(room);
            room.Open(url);
            return room;
        }

        private static void Done(params TickflareRoom[] rooms)
        {
            foreach (TickflareRoom room in rooms)
            {
                room.Close();
                Rooms.Remove(room);
            }
        }

        /// <summary>Waits until the condition holds, for at most so many seconds.</summary>
        private static async Task<bool> Until(Func<bool> condition, string what, double seconds = 5)
        {
            var watch = Stopwatch.StartNew();
            while (!condition())
            {
                if (watch.Elapsed.TotalSeconds > seconds)
                {
                    Check(false, "timed out waiting for " + what);
                    return false;
                }
                await Task.Yield();
            }
            return true;
        }

        /// <summary>How the room answered: null if it applied the command, or its reason for refusing.</summary>
        private static async Task<string> Answer(Task sent)
        {
            try
            {
                await sent;
                return null;
            }
            catch (TickflareRejectedException refused)
            {
                return refused.Reason;
            }
        }

        private static Dictionary<string, object> Script(string name)
        {
            return new Dictionary<string, object> { ["script"] = name };
        }

        private static async Task TestEventRoom(string server)
        {
            string name = FreshRoom();
            TickflareRoom plain = Join(server + "/shapes/" + name + "?player=p1", false);
            TickflareRoom packed = Join(server + "/shapes/" + name + "?player=p2", true);
            if (!await Until(() => plain.Status == TickflareStatus.Open && packed.Status == TickflareStatus.Open, "two clients to be welcomed"))
            {
                return;
            }
            Check(plain.You == "p1" && packed.You == "p2", "each client is told who it is");
            Check(plain.Protocol == 2 && packed.Protocol == 2, "the room speaks version 2 to both");
            await Until(() => packed.Players.Count == 2 && plain.Players.Count == 2, "both to hear of the other");
            var ids = new List<string>();
            foreach (TickflarePlayer player in packed.Players) ids.Add(player.Id + (player.Connected ? "" : " (away)"));
            ids.Sort(StringComparer.Ordinal);
            CheckSame(string.Join(", ", ids), "p1, p2", "the players are known");
            CheckSame(packed.State, plain.State, "both are welcomed with the same state");
            CheckSame(At(plain.State, "order"), J("[\"a\",\"b\"]"), "the state is the room's");

            int seen = 0;
            packed.StateChanged += _ => seen++;
            var done = new List<string>();
            foreach (string change in new[] { "mark", "move", "spawn", "copy", "shuffle", "replace", "remove", "mark" })
            {
                TickflareRoom sender = done.Count % 2 == 0 ? plain : packed;
                // Once as a dictionary, once as JSON that is written already.
                Task sent = done.Count % 3 == 0 ? sender.SendJsonAsync("{\"script\":\"" + change + "\"}") : sender.SendAsync(Script(change));
                Check(sender.Unconfirmed.Count == 1, "'" + change + "' is unconfirmed until the room answers");
                string refusal = await Answer(sent);
                done.Add(change);
                Check(refusal == null, "the room applied '" + change + "' (" + refusal + ")");
                await Until(() => plain.Seq == packed.Seq && plain.Seq >= done.Count, "both to have seen '" + change + "'");
                // Two decoders, JSON patches and binary ones, that have to end in the same place.
                CheckSame(packed.State, plain.State, "the state after " + string.Join(", ", done));
            }
            CheckSame(At(plain.State, "total"), 100, "the state the scripts lead to");
            CheckSame(At(plain.State, "order"), J("[\"c\",\"y\",\"z\"]"), "an array the scripts shuffled, replaced and cut");
            CheckSame(At(packed.State, "units", "b"), J("{\"x\":9,\"tags\":[\"copied\"]}"), "a unit the scripts copied");
            Check(At(plain.State, "units", "a") == null && At(plain.State, "units", "c") != null, "a unit removed and one added");
            Check(seen >= 8, "StateChanged was raised for every change");
            Check(plain.Unconfirmed.Count == 0 && packed.Unconfirmed.Count == 0, "nothing is left unconfirmed");
            Done(plain, packed);
            Check(plain.Status == TickflareStatus.Closed, "Close() closes");
        }

        private static async Task TestRefusals(string server)
        {
            TickflareRoom room = Join(server + "/shapes/" + FreshRoom() + "?player=p1");
            CheckSame(await Answer(room.SendAsync(Script("mark"))), "not_connected", "a command sent before the welcome");
            if (!await Until(() => room.Status == TickflareStatus.Open, "a client to be welcomed")) return;
            object total = At(room.State, "total");
            CheckSame(await Answer(room.SendAsync(Script("no-such-script"))), "no_such_script", "a command the room refuses");
            CheckSame(At(room.State, "total"), total, "a refused command changes nothing");
            Check(room.Unconfirmed.Count == 0, "a refused command is no longer unconfirmed");
            Done(room);
        }

        private static async Task TestTickingRoom(string server)
        {
            string name = FreshRoom();
            TickflareRoom plain = Join(server + "/ticks/" + name + "?player=p1", false);
            TickflareRoom packed = Join(server + "/ticks/" + name + "?player=p2", true);
            if (!await Until(() => plain.Status == TickflareStatus.Open && packed.Status == TickflareStatus.Open, "two clients in a ticking room"))
            {
                return;
            }
            Check(packed.TickRate == 50.0, "the tick rate is known");
            await Until(() => plain.Tick >= 10 && packed.Tick >= 10, "ten ticks");
            string refusal = await Answer(packed.SendAsync(new Dictionary<string, object> { ["type"] = "bump" }));
            Check(refusal == null, "a command in a ticking room is applied (" + refusal + ")");
            // The answer comes with the tick that shows the command.
            CheckSame(At(packed.State, "bumps"), 1, "the state shows the command by the time it is answered");
            await Until(() => Same(At(plain.State, "bumps"), 1), "the other client to see it");
            long from = Math.Max(plain.Tick, packed.Tick);
            await Until(() => plain.Tick >= from + 20 && packed.Tick >= from + 20, "twenty more ticks");
            Check(At(packed.State, "count") is double count && count > 20, "the simulation is followed");
            // Each player's view has their own secrets in it.
            Check(At(packed.State, "secrets", "p2") != null && At(packed.State, "secrets", "p1") == null, "a player sees their own view");
            Done(plain, packed);
        }

        private static async Task TestReconnect(string server)
        {
            var sockets = new List<BreakableSocket>();
            int tokens = 0;
            var room = new TickflareRoom
            {
                SocketFactory = () =>
                {
                    var socket = new BreakableSocket();
                    sockets.Add(socket);
                    return socket;
                },
                TokenProvider = () => Task.FromResult("token-" + ++tokens),
            };
            Rooms.Add(room);
            room.Open(server + "/shapes/" + FreshRoom() + "?player=p1&token=stale");
            if (!await Until(() => room.Status == TickflareStatus.Open, "a client to be welcomed")) return;
            Check(sockets.Count == 1 && sockets[0].Url.Contains("token=token-1") && !sockets[0].Url.Contains("stale"), "a fresh token is put in the URL");
            Check(sockets[0].Url.Contains("v=2") && sockets[0].Url.Contains("patches=b1"), "the URL asks for version 2 and binary patches");
            await Answer(room.SendAsync(Script("mark")));

            var statuses = new List<string>();
            room.StatusChanged += (status, code, reason) => statuses.Add(status + " " + code);
            Task lost = room.SendAsync(Script("nothing"));
            // The connection goes away under the client.
            sockets[0].Break();
            await Until(() => statuses.Count > 0, "the client to notice");
            Check(room.Status == TickflareStatus.Connecting, "a dropped connection is tried again");
            string answer = await Answer(lost);
            Check(answer == null || answer == "disconnected", "a command in flight is answered or lost, not left waiting (" + answer + ")");
            if (await Until(() => room.Status == TickflareStatus.Open, "the client to reconnect"))
            {
                CheckSame(string.Join(", ", statuses), "Connecting 1006, Open 0", "the statuses on the way back");
                Check(sockets.Count == 2 && sockets[1].Url.Contains("token=token-2"), "a new token for the new connection");
                CheckSame(At(room.State, "total"), 1, "the state is there after reconnecting");
                string refusal = await Answer(room.SendAsync(Script("mark")));
                Check(refusal == null && Same(At(room.State, "total"), 2), "commands work after reconnecting");
            }
            Done(room);
        }

        private static async Task TestReplacedAndLeave(string server)
        {
            string name = FreshRoom();
            TickflareRoom first = Join(server + "/shapes/" + name + "?player=p1");
            if (!await Until(() => first.Status == TickflareStatus.Open, "a client to be welcomed")) return;
            var closes = new List<string>();
            first.StatusChanged += (status, code, reason) => closes.Add(status + " " + code + " " + reason);
            // The same player connects again: the newer connection wins, and the older one stays closed.
            TickflareRoom second = Join(server + "/shapes/" + name + "?player=p1");
            await Until(() => second.Status == TickflareStatus.Open && first.Status == TickflareStatus.Closed, "the older connection to be replaced");
            CheckSame(string.Join(", ", closes), "Closed 4000 replaced", "replaced with code 4000, and not tried again");

            var ends = new List<string>();
            second.StatusChanged += (status, code, reason) => ends.Add(status + " " + code + " " + reason);
            string refusal = await Answer(second.LeaveAsync());
            Check(refusal == null, "LeaveAsync is answered (" + refusal + ")");
            await Until(() => second.Status == TickflareStatus.Closed, "the room to close the connection of a player who left");
            CheckSame(string.Join(", ", ends), "Closed 4003 left", "closed with code 4003 after leaving");
            Done(first, second);
        }
    }
}
