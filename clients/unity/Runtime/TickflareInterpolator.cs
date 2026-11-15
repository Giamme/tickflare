using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Tickflare
{
    /// <summary>
    /// Smooths values that arrive once per tick, for drawing between ticks.
    ///
    /// State sync delivers positions 10 to 30 times a second; a screen draws 60 or more. Each time
    /// a new value arrives for an id, the interpolator glides to it from wherever that id was being
    /// drawn, over <see cref="DurationMs"/> (one tick is the usual choice). Because it always starts
    /// from what is on screen, a late or bunched update bends the motion instead of making it jump.
    /// <code>
    /// var glide = new TickflareInterpolator(1000 / room.TickRate, "x", "y");
    /// room.StateChanged += state => glide.Update((Dictionary&lt;string, object&gt;)((Dictionary&lt;string, object&gt;)state)["units"]);
    /// // in Update():
    /// if (glide.TryGet(id, out var shown)) transform.position = new Vector3((float)shown["x"], 0, (float)shown["y"]);
    /// </code>
    /// </summary>
    public sealed class TickflareInterpolator
    {
        private sealed class Track
        {
            public Dictionary<string, double> From;
            public Dictionary<string, double> To;
            public double Since;
        }

        private static readonly Stopwatch Clock = Stopwatch.StartNew();
        private readonly string[] _fields;
        private Dictionary<string, Track> _tracks = new Dictionary<string, Track>();

        /// <param name="durationMs">How long a glide takes, usually the time between ticks.</param>
        /// <param name="fields">The numeric fields to smooth, e.g. "x" and "y".</param>
        public TickflareInterpolator(double durationMs, params string[] fields)
        {
            DurationMs = Math.Max(1, durationMs);
            _fields = (string[])fields.Clone();
        }

        /// <summary>How long a glide takes, in milliseconds.</summary>
        public double DurationMs { get; }

        /// <summary>
        /// Feeds the latest values, keyed by id: each a dictionary with the smoothed fields as numbers.
        /// Ids missing from <paramref name="targets"/> are forgotten; new ones start at their target.
        /// <paramref name="now"/> is in milliseconds, from a clock of the interpolator's own unless given.
        /// </summary>
        public void Update(IDictionary<string, object> targets, double? now = null)
        {
            if (targets == null) throw new ArgumentNullException(nameof(targets));
            double time = now ?? Clock.Elapsed.TotalMilliseconds;
            var tracks = new Dictionary<string, Track>();
            foreach (KeyValuePair<string, object> entry in targets)
            {
                var target = entry.Value as IDictionary<string, object>;
                var to = new Dictionary<string, double>();
                foreach (string field in _fields)
                {
                    to[field] = target != null && target.TryGetValue(field, out object value) ? Convert.ToDouble(value) : 0;
                }
                tracks[entry.Key] = new Track { From = TryGet(entry.Key, out Dictionary<string, double> shown, time) ? shown : to, To = to, Since = time };
            }
            _tracks = tracks;
        }

        /// <summary>The values to draw for <paramref name="id"/> right now. False if it is not known.</summary>
        public bool TryGet(string id, out Dictionary<string, double> values, double? now = null)
        {
            values = null;
            if (!_tracks.TryGetValue(id, out Track track)) return false;
            double time = now ?? Clock.Elapsed.TotalMilliseconds;
            double t = Math.Min(1, Math.Max(0, (time - track.Since) / DurationMs));
            values = new Dictionary<string, double>();
            foreach (string field in _fields) values[field] = track.From[field] + (track.To[field] - track.From[field]) * t;
            return true;
        }

        /// <summary>Forgets everything, e.g. after moving to another room.</summary>
        public void Clear()
        {
            _tracks.Clear();
        }
    }
}
