#if UNITY_5_3_OR_NEWER
using UnityEngine;

namespace Tickflare
{
    /// <summary>
    /// A room on a GameObject: it calls <see cref="TickflareRoom.Update"/> every frame and closes the
    /// connection when the object is destroyed.
    /// <code>
    /// var room = gameObject.AddComponent&lt;TickflareRunner&gt;().Room;
    /// room.StateChanged += Draw;
    /// room.Open(url);
    /// </code>
    /// </summary>
    [AddComponentMenu("Tickflare/Tickflare Room")]
    public sealed class TickflareRunner : MonoBehaviour
    {
        public TickflareRoom Room { get; } = new TickflareRoom();

        private void Update()
        {
            Room.Update();
        }

        private void OnDestroy()
        {
            Room.Close();
        }
    }
}
#endif
