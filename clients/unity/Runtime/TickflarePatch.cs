using System;
using System.Collections.Generic;

namespace Tickflare
{
    /// <summary>
    /// Applies a Tickflare patch to a state made of what <see cref="TickflareJson"/> gives.
    ///
    /// A patch mirrors the dictionary it changes. For each key it holds one of: a dictionary, which is
    /// a patch of what the key holds; a list of one element, the key's new value; a list of two, the
    /// changes to a list and its new length; or 0, which deletes the key.
    /// </summary>
    public static class TickflarePatch
    {
        /// <summary>
        /// Changes <paramref name="state"/> in place and returns it. A state that is not a dictionary is
        /// replaced by a new one, so use what is returned.
        /// </summary>
        public static Dictionary<string, object> Apply(object state, Dictionary<string, object> patch)
        {
            if (patch == null) throw new ArgumentNullException(nameof(patch));
            var target = state as Dictionary<string, object> ?? new Dictionary<string, object>();
            foreach (KeyValuePair<string, object> entry in patch)
            {
                switch (entry.Value)
                {
                    case Dictionary<string, object> nested:
                    {
                        target.TryGetValue(entry.Key, out object held);
                        target[entry.Key] = Apply(held, nested);
                        break;
                    }
                    case List<object> change when change.Count == 2:
                    {
                        target.TryGetValue(entry.Key, out object held);
                        target[entry.Key] = ApplyToList(held, change);
                        break;
                    }
                    case List<object> change when change.Count == 1:
                        target[entry.Key] = change[0];
                        break;
                    case List<object> _:
                        break;
                    default:
                        // 0: the key is deleted.
                        target.Remove(entry.Key);
                        break;
                }
            }
            return target;
        }

        private static List<object> ApplyToList(object held, List<object> change)
        {
            var changes = change[0] as Dictionary<string, object>;
            int length = change[1] is double size && size > 0 ? (int)Math.Min(size, int.MaxValue) : 0;
            var target = held as List<object> ?? new List<object>();
            // Elements past the new length are gone; ones the patch does not give are null.
            if (target.Count > length) target.RemoveRange(length, target.Count - length);
            while (target.Count < length) target.Add(null);
            if (changes == null) return target;

            foreach (KeyValuePair<string, object> entry in changes)
            {
                int index = Index(entry.Key);
                if (index < 0 || index >= length) continue;
                switch (entry.Value)
                {
                    case Dictionary<string, object> nested:
                        target[index] = Apply(target[index], nested);
                        break;
                    case List<object> inner when inner.Count == 2:
                        target[index] = ApplyToList(target[index], inner);
                        break;
                    case List<object> inner when inner.Count == 1:
                        target[index] = inner[0];
                        break;
                }
            }
            return target;
        }

        /// <summary>An index as a patch writes it, with no sign and no leading zero, or -1.</summary>
        private static int Index(string key)
        {
            if (key.Length == 0 || key.Length > 9) return -1;
            if (key[0] == '0' && key.Length > 1) return -1;
            int index = 0;
            foreach (char c in key)
            {
                if (c < '0' || c > '9') return -1;
                index = index * 10 + (c - '0');
            }
            return index;
        }
    }
}
