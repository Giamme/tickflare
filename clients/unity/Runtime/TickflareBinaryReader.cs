using System;
using System.Collections.Generic;
using System.Text;

namespace Tickflare
{
    /// <summary>
    /// Reads Tickflare's binary patch frames. The format is written down in the protocol reference,
    /// docs/reference/protocol.md in the Tickflare repository.
    ///
    /// One of these belongs to one connection: it holds the keys the room has defined on it.
    /// </summary>
    public sealed class TickflareBinaryReader
    {
        private const byte Magic = 0xb1;
        private const int FlagFrom = 1;
        private const int FlagShows = 2;
        private const int FlagForget = 4;

        private const int TagNull = 0;
        private const int TagFalse = 1;
        private const int TagTrue = 2;
        private const int TagInt = 3;
        private const int TagNegativeInt = 4;
        private const int TagTenths = 5;
        private const int TagNegativeTenths = 6;
        private const int TagHundredths = 7;
        private const int TagNegativeHundredths = 8;
        private const int TagFloat = 9;
        private const int TagString = 10;
        private const int TagArray = 11;
        private const int TagObject = 12;
        private const int TagDelete = 13;
        private const int TagNested = 14;
        private const int TagElements = 15;

        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        private byte[] _bytes;
        private int _at;

        /// <summary>The keys defined on this connection, by number.</summary>
        public List<string> Keys { get; } = new List<string>();

        /// <summary>
        /// The frame as the dictionary its JSON form would parse to: <c>t</c>, <c>seq</c>, <c>tick</c>
        /// and <c>p</c>, with <c>from</c> and <c>c</c> when the frame has them. Throws
        /// <see cref="FormatException"/> if the bytes are not a frame of this format: the keys can then
        /// no longer be trusted, and the connection has to be made again.
        /// </summary>
        public Dictionary<string, object> Decode(byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException(nameof(bytes));
            _bytes = bytes;
            _at = 0;
            try
            {
                if (Byte() != Magic) throw new FormatException("Not a binary patch frame");
                int flags = Byte();
                var frame = new Dictionary<string, object>
                {
                    ["t"] = "patch",
                    ["seq"] = (double)Varint(),
                    ["tick"] = (double)Varint(),
                };
                if ((flags & FlagFrom) != 0) frame["from"] = (double)Varint();
                if ((flags & FlagShows) != 0) frame["c"] = (double)Varint();
                if ((flags & FlagForget) != 0) Keys.Clear();
                for (int left = Count(); left > 0; left--) Keys.Add(String());
                frame["p"] = Patch(0);
                if (_at != _bytes.Length) throw new FormatException("The frame is longer than what it holds");
                return frame;
            }
            catch (ArgumentException error)
            {
                // Text that is not UTF-8.
                throw new FormatException("The frame has text that cannot be read", error);
            }
            finally
            {
                _bytes = null;
            }
        }

        private Dictionary<string, object> Patch(int depth)
        {
            var patch = new Dictionary<string, object>();
            for (int left = Count(); left > 0; left--)
            {
                string key = Key();
                patch[key] = Change(depth);
            }
            return patch;
        }

        /// <summary>What to do with one key of a dictionary or one element of a list.</summary>
        private object Change(int depth)
        {
            if (depth > 256) throw new FormatException("The frame is nested too deeply");
            int tag = Byte();
            if (tag == TagDelete) return 0.0;
            if (tag == TagNested) return Patch(depth + 1);
            if (tag != TagElements) return new List<object> { Value(tag, depth + 1) };

            double length = Varint();
            var changes = new Dictionary<string, object>();
            for (int left = Count(); left > 0; left--)
            {
                long index = Varint();
                changes[index.ToString(System.Globalization.CultureInfo.InvariantCulture)] = Change(depth + 1);
            }
            return new List<object> { changes, length };
        }

        private string Key()
        {
            long number = Varint();
            if (number == 0) return String();
            if (number > Keys.Count) throw new FormatException("The frame uses key " + (number - 1) + ", which was never defined");
            return Keys[(int)number - 1];
        }

        private object Value(int tag, int depth)
        {
            if (depth > 256) throw new FormatException("The frame is nested too deeply");
            switch (tag)
            {
                case TagNull:
                    return null;
                case TagFalse:
                    return false;
                case TagTrue:
                    return true;
                case TagInt:
                    return (double)Varint();
                case TagNegativeInt:
                    return -(double)Varint();
                case TagTenths:
                    return Varint() / 10.0;
                case TagNegativeTenths:
                    return -(Varint() / 10.0);
                case TagHundredths:
                    return Varint() / 100.0;
                case TagNegativeHundredths:
                    return -(Varint() / 100.0);
                case TagFloat:
                    return Double();
                case TagString:
                    return String();
                case TagArray:
                {
                    var items = new List<object>();
                    for (int left = Count(); left > 0; left--) items.Add(Value(Byte(), depth + 1));
                    return items;
                }
                case TagObject:
                {
                    var entries = new Dictionary<string, object>();
                    for (int left = Count(); left > 0; left--)
                    {
                        string key = Key();
                        entries[key] = Value(Byte(), depth + 1);
                    }
                    return entries;
                }
                default:
                    throw new FormatException("The frame has a value of a kind this client does not know: " + tag);
            }
        }

        private int Byte()
        {
            if (_at >= _bytes.Length) throw new FormatException("The frame ends too soon");
            return _bytes[_at++];
        }

        /// <summary>
        /// A whole number: seven bits to a byte, the lowest first, and the top bit of every byte but
        /// the last set.
        /// </summary>
        private long Varint()
        {
            long value = 0;
            int shift = 0;
            while (true)
            {
                int next = Byte();
                value += (long)(next & 0x7f) << shift;
                if (next < 0x80) return value;
                shift += 7;
                if (shift > 56) throw new FormatException("A number in the frame is too long");
            }
        }

        /// <summary>How many things follow. Each takes a byte at least, so more than are left is a lie.</summary>
        private int Count()
        {
            long count = Varint();
            if (count > _bytes.Length - _at) throw new FormatException("The frame ends too soon");
            return (int)count;
        }

        /// <summary>Eight bytes, big-endian.</summary>
        private double Double()
        {
            if (_at + 8 > _bytes.Length) throw new FormatException("The frame ends too soon");
            long bits = 0;
            for (int index = 0; index < 8; index++) bits = (bits << 8) | _bytes[_at + index];
            _at += 8;
            return BitConverter.Int64BitsToDouble(bits);
        }

        private string String()
        {
            int length = Count();
            string text = Utf8.GetString(_bytes, _at, length);
            _at += length;
            return text;
        }
    }
}
