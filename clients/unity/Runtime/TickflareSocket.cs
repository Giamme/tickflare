using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Tickflare
{
    /// <summary>One thing a connection gave: a message, or the news that it closed.</summary>
    public struct TickflareSocketMessage
    {
        /// <summary>The connection is over. <see cref="CloseCode"/> and <see cref="CloseReason"/> say why.</summary>
        public bool IsClose;
        public int CloseCode;
        public string CloseReason;
        /// <summary>A text message, as UTF-8 in <see cref="Data"/>; otherwise a binary one.</summary>
        public bool IsText;
        public byte[] Data;

        public static TickflareSocketMessage Closed(int code, string reason)
        {
            return new TickflareSocketMessage { IsClose = true, CloseCode = code, CloseReason = reason ?? "" };
        }
    }

    /// <summary>
    /// The WebSocket a <see cref="TickflareRoom"/> talks through. The one it uses unless told otherwise
    /// is <see cref="TickflareWebSocket"/>, which does not exist in a WebGL build: there, give the room
    /// a <see cref="TickflareRoom.SocketFactory"/> that wraps the browser's WebSocket.
    ///
    /// A socket is used for one connection. Its methods may be called from any thread.
    /// </summary>
    public interface ITickflareSocket : IDisposable
    {
        Task ConnectAsync(Uri url, CancellationToken cancel);

        /// <summary>Sends a text message. Messages go out in the order they were given.</summary>
        Task SendAsync(string text, CancellationToken cancel);

        /// <summary>The next whole message, or a close. Not called again before the last call ended.</summary>
        Task<TickflareSocketMessage> ReceiveAsync(CancellationToken cancel);

        /// <summary>Says goodbye, after what was still to be sent. Does nothing on a connection that is over.</summary>
        Task CloseAsync(int code, string reason, CancellationToken cancel);
    }

    /// <summary>A socket on .NET's <see cref="ClientWebSocket"/>: desktop, mobile and consoles.</summary>
    public sealed class TickflareWebSocket : ITickflareSocket
    {
        private sealed class Outgoing
        {
            public string Text;
            public bool Close;
            public int Code;
            public string Reason;
            public readonly TaskCompletionSource<bool> Done =
                new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private readonly ClientWebSocket _socket = new ClientWebSocket();
        private readonly Queue<Outgoing> _outbox = new Queue<Outgoing>();
        private bool _draining;
        private byte[] _buffer = new byte[16 * 1024];

        /// <summary>The longest message the room may send, in bytes. A whole state is one message.</summary>
        public int MaxMessageBytes { get; set; } = 16 * 1024 * 1024;

        public Task ConnectAsync(Uri url, CancellationToken cancel)
        {
            return _socket.ConnectAsync(url, cancel);
        }

        public Task SendAsync(string text, CancellationToken cancel)
        {
            return Enqueue(new Outgoing { Text = text }, cancel);
        }

        public Task CloseAsync(int code, string reason, CancellationToken cancel)
        {
            return Enqueue(new Outgoing { Close = true, Code = code, Reason = reason ?? "" }, cancel);
        }

        public async Task<TickflareSocketMessage> ReceiveAsync(CancellationToken cancel)
        {
            int length = 0;
            while (true)
            {
                if (length == _buffer.Length)
                {
                    if (length >= MaxMessageBytes) throw new WebSocketException("The room sent a message longer than MaxMessageBytes");
                    Array.Resize(ref _buffer, Math.Min(MaxMessageBytes, _buffer.Length * 2));
                }
                WebSocketReceiveResult result = await _socket
                    .ReceiveAsync(new ArraySegment<byte>(_buffer, length, _buffer.Length - length), cancel)
                    .ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    int code = result.CloseStatus.HasValue ? (int)result.CloseStatus.Value : 1005;
                    return TickflareSocketMessage.Closed(code, result.CloseStatusDescription);
                }
                length += result.Count;
                if (!result.EndOfMessage) continue;

                var data = new byte[length];
                Buffer.BlockCopy(_buffer, 0, data, 0, length);
                return new TickflareSocketMessage { IsText = result.MessageType == WebSocketMessageType.Text, Data = data };
            }
        }

        public void Dispose()
        {
            _socket.Dispose();
        }

        // ClientWebSocket takes one send at a time: they wait their turn here.
        private Task Enqueue(Outgoing item, CancellationToken cancel)
        {
            bool start;
            lock (_outbox)
            {
                _outbox.Enqueue(item);
                start = !_draining;
                _draining = true;
            }
            if (start) _ = Drain(cancel);
            return item.Done.Task;
        }

        private async Task Drain(CancellationToken cancel)
        {
            while (true)
            {
                Outgoing item;
                lock (_outbox)
                {
                    if (_outbox.Count == 0)
                    {
                        _draining = false;
                        return;
                    }
                    item = _outbox.Dequeue();
                }
                try
                {
                    if (!item.Close)
                    {
                        byte[] bytes = Encoding.UTF8.GetBytes(item.Text);
                        await _socket
                            .SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancel)
                            .ConfigureAwait(false);
                    }
                    else if (_socket.State == WebSocketState.Open || _socket.State == WebSocketState.CloseReceived)
                    {
                        await _socket
                            .CloseOutputAsync((WebSocketCloseStatus)item.Code, item.Reason, cancel)
                            .ConfigureAwait(false);
                    }
                    item.Done.TrySetResult(true);
                }
                catch (Exception error)
                {
                    item.Done.TrySetException(error);
                }
            }
        }
    }
}
