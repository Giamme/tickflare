declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TestRoom";
  }
  interface Env {
    ROOMS: DurableObjectNamespace<import("./worker").TestRoom>;
  }
}
