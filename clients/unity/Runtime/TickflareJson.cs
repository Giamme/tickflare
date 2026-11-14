using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Tickflare
{
    /// <summary>
    /// JSON as plain values: an object is a <c>Dictionary&lt;string, object&gt;</c>, an array a
    /// <c>List&lt;object&gt;</c>, a number a <c>double</c>, and the rest <c>string</c>, <c>bool</c> and
    /// <c>null</c>. A room's state is made of these.
    /// </summary>
    public static class TickflareJson
    {
        private const int MaxDepth = 256;

        /// <summary>Reads one JSON value. Throws <see cref="FormatException"/> if the text is not JSON.</summary>
        public static object Parse(string text)
        {
            if (text == null) throw new ArgumentNullException(nameof(text));
            var reader = new Reader(text);
            object value = reader.Value(0);
            reader.SkipSpace();
            if (!reader.AtEnd) throw new FormatException("Unexpected text after the JSON value, at " + reader.Position);
            return value;
        }

        /// <summary>
        /// Writes a value as JSON: dictionaries with string keys, lists and arrays, strings, numbers of
        /// any kind, booleans and null. Throws <see cref="ArgumentException"/> for anything else.
        /// </summary>
        public static string Stringify(object value)
        {
            var text = new StringBuilder();
            Write(text, value, 0);
            return text.ToString();
        }

        private static void Write(StringBuilder text, object value, int depth)
        {
            if (depth > MaxDepth) throw new ArgumentException("The value is nested too deeply to write as JSON");
            switch (value)
            {
                case null:
                    text.Append("null");
                    break;
                case string s:
                    WriteString(text, s);
                    break;
                case bool b:
                    text.Append(b ? "true" : "false");
                    break;
                case double d:
                    WriteNumber(text, d);
                    break;
                case float f:
                    // By its own shortest form: 0.1f is 0.1, not the double nearest to it.
                    if (float.IsNaN(f) || float.IsInfinity(f)) text.Append("null");
                    else WriteNumber(text, double.Parse(f.ToString("R", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture));
                    break;
                case Enum named:
                    text.Append(Convert.ToInt64(named, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                    break;
                case decimal m:
                    text.Append(m.ToString(CultureInfo.InvariantCulture));
                    break;
                case IConvertible number when IsWhole(number.GetTypeCode()):
                    text.Append(number.ToString(CultureInfo.InvariantCulture));
                    break;
                case IDictionary dictionary:
                {
                    text.Append('{');
                    bool first = true;
                    foreach (DictionaryEntry entry in dictionary)
                    {
                        if (!(entry.Key is string key)) throw new ArgumentException("JSON objects have strings as keys");
                        if (!first) text.Append(',');
                        first = false;
                        WriteString(text, key);
                        text.Append(':');
                        Write(text, entry.Value, depth + 1);
                    }
                    text.Append('}');
                    break;
                }
                case IEnumerable list:
                {
                    text.Append('[');
                    bool first = true;
                    foreach (object item in list)
                    {
                        if (!first) text.Append(',');
                        first = false;
                        Write(text, item, depth + 1);
                    }
                    text.Append(']');
                    break;
                }
                default:
                    throw new ArgumentException("Cannot write a " + value.GetType().Name + " as JSON");
            }
        }

        private static bool IsWhole(TypeCode code)
        {
            switch (code)
            {
                case TypeCode.SByte:
                case TypeCode.Byte:
                case TypeCode.Int16:
                case TypeCode.UInt16:
                case TypeCode.Int32:
                case TypeCode.UInt32:
                case TypeCode.Int64:
                case TypeCode.UInt64:
                    return true;
                default:
                    return false;
            }
        }

        private static void WriteNumber(StringBuilder text, double number)
        {
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                // As JSON.stringify does: there is no way to write these.
                text.Append("null");
            }
            else if (number == Math.Floor(number) && Math.Abs(number) < 1e15)
            {
                text.Append(((long)number).ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                text.Append(number.ToString("R", CultureInfo.InvariantCulture));
            }
        }

        private static void WriteString(StringBuilder text, string value)
        {
            text.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"':
                        text.Append("\\\"");
                        break;
                    case '\\':
                        text.Append("\\\\");
                        break;
                    case '\n':
                        text.Append("\\n");
                        break;
                    case '\r':
                        text.Append("\\r");
                        break;
                    case '\t':
                        text.Append("\\t");
                        break;
                    default:
                        if (c < ' ') text.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else text.Append(c);
                        break;
                }
            }
            text.Append('"');
        }

        private sealed class Reader
        {
            private readonly string _text;
            private int _at;

            public Reader(string text)
            {
                _text = text;
            }

            public bool AtEnd => _at >= _text.Length;
            public int Position => _at;

            public void SkipSpace()
            {
                while (_at < _text.Length)
                {
                    char c = _text[_at];
                    if (c != ' ' && c != '\n' && c != '\r' && c != '\t') break;
                    _at++;
                }
            }

            public object Value(int depth)
            {
                if (depth > MaxDepth) throw new FormatException("The JSON is nested too deeply");
                SkipSpace();
                switch (Peek())
                {
                    case '{':
                        return Object(depth);
                    case '[':
                        return Array(depth);
                    case '"':
                        return String();
                    case 't':
                        Word("true");
                        return true;
                    case 'f':
                        Word("false");
                        return false;
                    case 'n':
                        Word("null");
                        return null;
                    default:
                        return Number();
                }
            }

            private char Peek()
            {
                return _at < _text.Length ? _text[_at] : '\0';
            }

            private FormatException Bad(string expected)
            {
                return new FormatException("Expected " + expected + " in the JSON, at " + _at);
            }

            private void Word(string word)
            {
                if (string.CompareOrdinal(_text, _at, word, 0, word.Length) != 0) throw Bad("a value");
                _at += word.Length;
            }

            private Dictionary<string, object> Object(int depth)
            {
                var result = new Dictionary<string, object>();
                _at++;
                SkipSpace();
                if (Peek() == '}')
                {
                    _at++;
                    return result;
                }
                while (true)
                {
                    SkipSpace();
                    if (Peek() != '"') throw Bad("a key");
                    string key = String();
                    SkipSpace();
                    if (Peek() != ':') throw Bad("':'");
                    _at++;
                    result[key] = Value(depth + 1);
                    SkipSpace();
                    char next = Peek();
                    _at++;
                    if (next == '}') return result;
                    if (next != ',') throw Bad("',' or '}'");
                }
            }

            private List<object> Array(int depth)
            {
                var result = new List<object>();
                _at++;
                SkipSpace();
                if (Peek() == ']')
                {
                    _at++;
                    return result;
                }
                while (true)
                {
                    result.Add(Value(depth + 1));
                    SkipSpace();
                    char next = Peek();
                    _at++;
                    if (next == ']') return result;
                    if (next != ',') throw Bad("',' or ']'");
                }
            }

            private string String()
            {
                _at++;
                StringBuilder built = null;
                int start = _at;
                while (true)
                {
                    if (_at >= _text.Length) throw Bad("the end of a string");
                    char c = _text[_at];
                    if (c == '"')
                    {
                        string result = built == null
                            ? _text.Substring(start, _at - start)
                            : built.Append(_text, start, _at - start).ToString();
                        _at++;
                        return result;
                    }
                    if (c != '\\')
                    {
                        _at++;
                        continue;
                    }
                    if (built == null) built = new StringBuilder();
                    built.Append(_text, start, _at - start);
                    _at++;
                    if (_at >= _text.Length) throw Bad("the end of a string");
                    char escape = _text[_at++];
                    switch (escape)
                    {
                        case '"':
                        case '\\':
                        case '/':
                            built.Append(escape);
                            break;
                        case 'b':
                            built.Append('\b');
                            break;
                        case 'f':
                            built.Append('\f');
                            break;
                        case 'n':
                            built.Append('\n');
                            break;
                        case 'r':
                            built.Append('\r');
                            break;
                        case 't':
                            built.Append('\t');
                            break;
                        case 'u':
                            if (_at + 4 > _text.Length) throw Bad("four hex digits");
                            if (!ushort.TryParse(_text.Substring(_at, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out ushort unit))
                            {
                                throw Bad("four hex digits");
                            }
                            built.Append((char)unit);
                            _at += 4;
                            break;
                        default:
                            throw Bad("an escape");
                    }
                    start = _at;
                }
            }

            private object Number()
            {
                int start = _at;
                while (_at < _text.Length)
                {
                    char c = _text[_at];
                    if ((c < '0' || c > '9') && c != '-' && c != '+' && c != '.' && c != 'e' && c != 'E') break;
                    _at++;
                }
                if (_at == start) throw Bad("a value");
                if (!double.TryParse(_text.Substring(start, _at - start), NumberStyles.Float, CultureInfo.InvariantCulture, out double number))
                {
                    _at = start;
                    throw Bad("a number");
                }
                return number;
            }
        }
    }
}
