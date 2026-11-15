#if UNITY_WEBGL && !UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Tickflare
{
    /// <summary>
    /// A socket on the browser's WebSocket, for WebGL builds, where .NET's ClientWebSocket does not
    /// exist. <see cref="TickflareRoom"/> uses it there by itself.
    ///
    /// Untested: it has not been run in a WebGL build. The browser's events wait in a queue until
    /// <see cref="Pump"/> hands them over, on the main thread, so nothing here needs a thread or a
    /// timer. <see cref="TickflareRoom.Update"/> pumps, so a room that is updated every frame
    /// (a <see cref="TickflareRunner"/> does that) needs nothing more.
    /// </summary>
    public sealed class TickflareBrowserSocket : ITickflareSocket
    {
        private const int Open = 1;
        private const int Text = 2;
        private const int Binary = 3;
        private const int Closed = 4;

        [DllImport("__Internal")] private static extern int TickflareSocketOpen(string url);
        [DllImport("__Internal")] private static extern int TickflareSocketPeek(int id, out int kind, out int code);
        [DllImport("__Internal")] private static extern void TickflareSocketTake(int id, byte[] buffer);
        [DllImport("__Internal")] private static extern void TickflareSocketSend(int id, string text);
        [DllImport("__Internal")] private static extern void TickflareSocketClose(int id, int code, string reason);
        [DllImport("__Internal")] private static extern void TickflareSocketFree(int id);

        private static readonly List<TickflareBrowserSocket> Live = new List<TickflareBrowserSocket>();
        private static readonly byte[] Nothing = new byte[0];

        private int _id;
        private TaskCompletionSource<bool> _opening;
        private TaskCompletionSource<TickflareSocketMessage> _receiving;
        private CancellationTokenRegistration _openCancel;
        private CancellationTokenRegistration _receiveCancel;

        /// <summary>Hands what the browser received to whoever waits for it. Call on the main thread.</summary>
        public static void Pump()
        {
            foreach (var socket in Live.ToArray()) socket.Deliver();
        }

        public Task ConnectAsync(Uri url, CancellationToken cancel)
        {
            cancel.ThrowIfCancellationRequested();
            _id = TickflareSocketOpen(url.ToString());
            Live.Add(this);
            var opening = new TaskCompletionSource<bool>();
            _opening = opening;
            _openCancel = cancel.Register(() =>
            {
                if (_opening == opening) _opening = null;
                opening.TrySetCanceled();
            });
            Deliver();
            return opening.Task;
        }

        public Task SendAsync(string text, CancellationToken cancel)
        {
            TickflareSocketSend(_id, text);
            return Task.CompletedTask;
        }

        public Task<TickflareSocketMessage> ReceiveAsync(CancellationToken cancel)
        {
            cancel.ThrowIfCancellationRequested();
            if (TryTake(out var message)) return Task.FromResult(message);
            var receiving = new TaskCompletionSource<TickflareSocketMessage>();
            _receiving = receiving;
            _receiveCancel.Dispose();
            _receiveCancel = cancel.Register(() =>
            {
                if (_receiving == receiving) _receiving = null;
                receiving.TrySetCanceled();
            });
            return receiving.Task;
        }

        public Task CloseAsync(int code, string reason, CancellationToken cancel)
        {
            TickflareSocketClose(_id, code, reason ?? "");
            return Task.CompletedTask;
        }

        public void Dispose()
        {
            _openCancel.Dispose();
            _receiveCancel.Dispose();
            Live.Remove(this);
            TickflareSocketFree(_id);
        }

        private void Deliver()
        {
            if (_opening != null)
            {
                int length = TickflareSocketPeek(_id, out int kind, out int code);
                if (length < 0) return;
                var opening = _opening;
                if (kind == Open)
                {
                    TickflareSocketTake(_id, Nothing);
                    _opening = null;
                    opening.TrySetResult(true);
                }
                else if (kind == Closed)
                {
                    // The close stays queued: whoever receives next reads it as the end.
                    _opening = null;
                    opening.TrySetException(new InvalidOperationException("The connection was refused (" + code + ")"));
                }
                return;
            }
            if (_receiving != null && TryTake(out var message))
            {
                var receiving = _receiving;
                _receiving = null;
                // Runs the receiver on, here: it takes the rest of the queue before this returns.
                receiving.TrySetResult(message);
            }
        }

        private bool TryTake(out TickflareSocketMessage message)
        {
            while (true)
            {
                int length = TickflareSocketPeek(_id, out int kind, out int code);
                if (length < 0)
                {
                    message = default;
                    return false;
                }
                var data = length == 0 ? Nothing : new byte[length];
                TickflareSocketTake(_id, data);
                if (kind == Closed)
                {
                    message = TickflareSocketMessage.Closed(code, Encoding.UTF8.GetString(data));
                    return true;
                }
                if (kind == Text || kind == Binary)
                {
                    message = new TickflareSocketMessage { IsText = kind == Text, Data = data };
                    return true;
                }
            }
        }
    }
}
#endif
