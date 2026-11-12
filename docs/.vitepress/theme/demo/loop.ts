import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * Runs a demo: `advance` moves it on by some milliseconds and `draw` paints
 * it. It plays while it is on screen and the tab is visible, pauses when
 * asked, and with reduced motion waits to be started.
 */
export function useLoop(root: Ref<HTMLElement | null>, options: { setup(): void; advance(ms: number): void; draw(): void }) {
  const playing = ref(false);
  /** The phone layout: screens side by side, room beneath. */
  const vertical = ref(false);
  /** The visitor prefers reduced motion, so nothing has started by itself. */
  const waiting = ref(false);

  let frame = 0;
  let last = 0;
  let userPaused = false;
  let inView = false;

  function loop(now: number): void {
    // A tab that was in the background comes back with one long frame; don't replay it.
    options.advance(Math.min(50, now - last));
    last = now;
    options.draw();
    if (playing.value) frame = requestAnimationFrame(loop);
  }

  function play(): void {
    userPaused = false;
    waiting.value = false;
    if (playing.value) return;
    playing.value = true;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  function pause(byUser: boolean): void {
    if (byUser) userPaused = true;
    playing.value = false;
    cancelAnimationFrame(frame);
  }

  let observer: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;
  let media: MediaQueryList | undefined;
  const onMedia = () => (vertical.value = media?.matches ?? false);
  const onHidden = () => {
    if (document.hidden) pause(false);
    else if (inView && !userPaused) play();
  };

  onMounted(() => {
    media = window.matchMedia("(max-width: 760px)");
    onMedia();
    media.addEventListener("change", onMedia);
    document.addEventListener("visibilitychange", onHidden);
    options.setup();
    options.draw();
    resize = new ResizeObserver(() => !playing.value && options.draw());
    if (root.value) resize.observe(root.value);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      userPaused = true;
      waiting.value = true;
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        if (inView && !userPaused) play();
        else if (!inView) pause(false);
      },
      { threshold: 0.25 },
    );
    if (root.value) observer.observe(root.value);
  });

  onBeforeUnmount(() => {
    pause(false);
    observer?.disconnect();
    resize?.disconnect();
    media?.removeEventListener("change", onMedia);
    document.removeEventListener("visibilitychange", onHidden);
  });

  return { playing, vertical, waiting, play, pause };
}

/** Sizes a square canvas for the screen it is on and returns its context. */
export function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const size = Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1));
  if (size > 0 && canvas.width !== size) canvas.width = canvas.height = size;
  return canvas.getContext("2d");
}

export function disc(ctx: CanvasRenderingContext2D, k: number, at: { x: number; y: number }, radius: number): void {
  ctx.beginPath();
  ctx.arc(at.x * k, at.y * k, radius * k, 0, Math.PI * 2);
}
