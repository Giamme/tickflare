using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;

namespace Tickflare
{
    /// <summary>
    /// What a <see cref="TickflarePredictor"/> needs of a room. <see cref="TickflareRoom"/> is one;
    /// so is anything that gives a part of a room's state, for predicting only that part.
    /// </summary>
    public interface ITickflareRoomView
    {
        /// <summary>The room's state, as <see cref="TickflareJson"/> gives it.</summary>
        object State { get; }
        long Tick { get; }
        double TickRate { get; }
        string You { get; }
        IReadOnlyList<TickflareSentCommand> Unconfirmed { get; }
        /// <summary>The state changed.</summary>
        event Action<object> StateChanged;
        /// <summary>A command was sent: raised before <see cref="SendAsync"/> starts waiting for the answer.</summary>
        event Action<TickflareSentCommand> CommandSent;
        /// <summary>Sends a command; ends when the room has applied it, fails if it refused it.</summary>
        Task SendAsync(object command);
    }

    /// <summary>
    /// Shows a player the effect of their own commands at once, instead of when the room's answer arrives.
    ///
    /// <see cref="State"/> is the room's state with this player's unconfirmed commands applied on top,
    /// by the <c>apply</c> you give. When the room's state arrives it replaces the guess: commands the
    /// room has applied are part of it, commands it refused are dropped, and those still on their way
    /// are applied again. So a wrong guess lasts until the room's answer, and never longer.
    /// <code>
    /// var predicted = new TickflarePredictor(room, (state, command, you) =>
    /// {
    ///     var c = (Dictionary&lt;string, object&gt;)command;
    ///     if ((string)c["type"] == "move") Units(state)[you]["target"] = c["to"];
    /// });
    /// await predicted.SendAsync(new Dictionary&lt;string, object&gt; { ["type"] = "move", ["to"] = 5.0 });
    /// Draw(predicted.State);
    /// </code>
    /// Send through <see cref="SendAsync"/>, and draw from <see cref="State"/> where you drew from
    /// <c>room.State</c>. With a <c>tick</c> as well, the prediction runs as far ahead of the room's
    /// state as a command takes to show there, and moves the player's own units the way the room's
    /// simulation would.
    ///
    /// The prediction is made on a copy of the room's state, made again when a frame arrives or a
    /// command is sent or answered. For a large state, predict a part of it, with an
    /// <see cref="ITickflareRoomView"/> whose state is that part.
    /// </summary>
    public sealed class TickflarePredictor : IDisposable
    {
        private const int FramesKept = 20;
        private const double RestartMs = 1000;
        private const int LeadsKept = 7;
        private static readonly Stopwatch Clock = Stopwatch.StartNew();

        private readonly ITickflareRoomView _room;
        private readonly Action<object, object, string> _apply;
        private readonly Action<object, string> _tick;
        private readonly Func<double> _now;
        private readonly Dictionary<long, long> _sentAt = new Dictionary<long, long>();
        private readonly List<double> _arrivals = new List<double>();
        private readonly List<long> _leads = new List<long>();
        private long _lastTick = -1;
        private long _frames;
        private string _madeKey;
        private object _made;
        private string _toldKey;

        /// <param name="room">The room, or a view of a part of it.</param>
        /// <param name="apply">
        /// What one of this player's commands does: changes the state in place, as the room's
        /// <c>onCommand</c> does. Given the state, the command and this player's id.
        /// </param>
        /// <param name="tick">
        /// What one tick does to what this player controls, as the room's <c>onTick</c> does. Leave
        /// other players' units alone. Optional.
        /// </param>
        /// <param name="now">The time in milliseconds. A clock of the predictor's own unless given.</param>
        public TickflarePredictor(ITickflareRoomView room, Action<object, object, string> apply, Action<object, string> tick = null, Func<double> now = null)
        {
            _room = room ?? throw new ArgumentNullException(nameof(room));
            _apply = apply ?? throw new ArgumentNullException(nameof(apply));
            _tick = tick;
            _now = now ?? (() => Clock.Elapsed.TotalMilliseconds);
            room.StateChanged += OnRoomState;
            if (room.State != null) Hear();
        }

        /// <summary>
        /// The predicted state changed: a frame arrived, or a command was sent, applied or refused.
        /// With a <c>tick</c>, the prediction also moves on with time: read <see cref="State"/> when you draw.
        /// </summary>
        public event Action<object> StateChanged;

        /// <summary>
        /// The room's state as it will be once the room has applied this player's unconfirmed commands.
        /// Null until the room's first state arrives.
        /// </summary>
        public object State => Predict();

        /// <summary>
        /// With a <c>tick</c>: how many ticks ahead of the room's state the prediction runs, which is
        /// how long a command takes to show there. Measured from the commands sent so far; 1 before
        /// the first has come back.
        /// </summary>
        public long Lead { get; private set; } = 1;

        /// <summary>
        /// Sends a command, and shows its effect at once. Ends and fails as the room's
        /// <c>SendAsync</c> does. If the room refuses the command, its effect is taken back.
        /// </summary>
        public async Task SendAsync(object command)
        {
            long at = Math.Max(_room.Tick, RoomTick());
            long? id = null;
            // The room says which id the command has before it starts waiting for the answer.
            void Note(TickflareSentCommand sent)
            {
                if (id.HasValue) return;
                id = sent.Id;
                _sentAt[sent.Id] = at;
            }
            _room.CommandSent += Note;
            Task waiting;
            try
            {
                waiting = _room.SendAsync(command);
            }
            finally
            {
                _room.CommandSent -= Note;
            }
            Changed();
            bool applied = false;
            try
            {
                await waiting;
                applied = true;
            }
            finally
            {
                if (id.HasValue)
                {
                    _sentAt.Remove(id.Value);
                    // The room's tick is now the one that first showed the command.
                    if (applied && _tick != null && _room.TickRate > 0) Learn(_room.Tick - at);
                    Changed();
                }
            }
        }

        /// <summary>Stops following the room. The room itself stays connected.</summary>
        public void Dispose()
        {
            _room.StateChanged -= OnRoomState;
        }

        private void OnRoomState(object state)
        {
            _frames++;
            Hear();
            Changed();
        }

        private object Predict()
        {
            object baseState = _room.State;
            IReadOnlyList<TickflareSentCommand> pending = _room.Unconfirmed;
            string you = _room.You;
            bool ticking = _tick != null && _room.TickRate > 0 && baseState != null;
            long from = 0;
            long to = 0;
            if (ticking)
            {
                long now = RoomTick();
                // If frames have stopped coming, the state is taken to be a few ticks old at most:
                // nothing in this player's view changed in the ticks without a frame.
                from = Math.Max(_room.Tick, now - MostBehind());
                to = now + Lead;
            }

            var key = new StringBuilder();
            key.Append(_frames).Append('|').Append(from).Append('|').Append(to).Append('|').Append(Lead).Append('|').Append(baseState == null);
            foreach (TickflareSentCommand sent in pending)
            {
                key.Append('|').Append(sent.Id).Append('@').Append(_sentAt.TryGetValue(sent.Id, out long known) ? known : 0);
            }
            string madeKey = key.ToString();
            if (madeKey == _madeKey) return _made;

            object predicted = baseState;
            if (baseState != null && (pending.Count > 0 || to > from))
            {
                predicted = DeepCopy(baseState);
                int next = 0;
                void ApplyDue(double before)
                {
                    while (next < pending.Count)
                    {
                        TickflareSentCommand sent = pending[next];
                        long sentTick = _sentAt.TryGetValue(sent.Id, out long recorded) ? recorded : 0;
                        if (sentTick + Lead > before) break;
                        Try(() => _apply(predicted, sent.Command, you));
                        next++;
                    }
                }
                for (long at = from + 1; at <= to; at++)
                {
                    ApplyDue(at);
                    Try(() => _tick(predicted, you));
                }
                ApplyDue(double.PositiveInfinity);
            }
            _madeKey = madeKey;
            _made = predicted;
            return predicted;
        }

        private void Changed()
        {
            object predicted = Predict();
            if (predicted == null || _madeKey == _toldKey) return;
            _toldKey = _madeKey;
            StateChanged?.Invoke(predicted);
        }

        private static void Try(Action change)
        {
            try
            {
                change();
            }
            catch (Exception)
            {
                // A prediction that fails is a prediction not made: the room's answer will show what happened.
            }
        }

        /// <summary>A frame arrived: note when, to tell what tick the room is at between frames.</summary>
        private void Hear()
        {
            if (_tick == null || _room.TickRate <= 0 || _room.Tick == _lastTick) return;
            _lastTick = _room.Tick;
            double arrival = _now() - _room.Tick * 1000.0 / _room.TickRate;
            if (_arrivals.Count > 0 && arrival - Earliest() > RestartMs) _arrivals.Clear();
            _arrivals.Add(arrival);
            if (_arrivals.Count > FramesKept) _arrivals.RemoveAt(0);
        }

        private double Earliest()
        {
            double earliest = double.PositiveInfinity;
            foreach (double arrival in _arrivals) earliest = Math.Min(earliest, arrival);
            return earliest;
        }

        /// <summary>
        /// The tick the room's latest frame would be of, were one to arrive now. Frames are late by as
        /// much as the network holds them up, so the one that was held up least says when ticks happen.
        /// </summary>
        private long RoomTick()
        {
            if (_arrivals.Count == 0 || _room.TickRate <= 0) return _room.Tick;
            // A hair is added so that the frame the clock was read from is not put a tick early by rounding.
            long ticks = (long)Math.Floor((_now() - Earliest()) * _room.TickRate / 1000.0 + 1e-6);
            return Math.Max(_room.Tick, ticks);
        }

        /// <summary>How many ticks without a frame are taken for a frame that is late, rather than for nothing having changed.</summary>
        private long MostBehind()
        {
            return Math.Max(2, (long)Math.Ceiling(_room.TickRate / 4));
        }

        /// <summary>A command took <paramref name="ticks"/> ticks to show in the room's state. The lead is the middle of the latest few.</summary>
        private void Learn(long ticks)
        {
            _leads.Add(Math.Max(1, Math.Min(ticks, (long)(2 * _room.TickRate))));
            if (_leads.Count > LeadsKept) _leads.RemoveAt(0);
            var sorted = new List<long>(_leads);
            sorted.Sort();
            Lead = sorted[sorted.Count / 2];
        }

        /// <summary>A copy of a value made of what <see cref="TickflareJson"/> gives, sharing nothing with it.</summary>
        public static object DeepCopy(object value)
        {
            switch (value)
            {
                case Dictionary<string, object> dictionary:
                {
                    var copy = new Dictionary<string, object>(dictionary.Count);
                    foreach (KeyValuePair<string, object> entry in dictionary) copy[entry.Key] = DeepCopy(entry.Value);
                    return copy;
                }
                case List<object> list:
                {
                    var copy = new List<object>(list.Count);
                    foreach (object item in list) copy.Add(DeepCopy(item));
                    return copy;
                }
                default:
                    return value;
            }
        }
    }
}
