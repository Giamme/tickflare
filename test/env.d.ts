declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TestRoom" | "TickRoom";
  }
  interface Env {
    ROOMS: DurableObjectNamespace<import("./worker").TestRoom>;
    TICKS: DurableObjectNamespace<import("./worker").TickRoom>;
  }
}
