declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TestRoom" | "TickRoom" | "TurnRoom" | "TestMatchmaker" | "AwayRoom";
  }
  interface Env {
    ROOMS: DurableObjectNamespace<import("./worker").TestRoom>;
    TICKS: DurableObjectNamespace<import("./worker").TickRoom>;
    TURNS: DurableObjectNamespace<import("./worker").TurnRoom>;
    AWAY: DurableObjectNamespace<import("./worker").AwayRoom>;
    MATCHMAKER: DurableObjectNamespace<import("./worker").TestMatchmaker>;
    MATCHES: Queue<import("../src/protocol.js").MatchResult>;
    DB: D1Database;
    REPLAYS: R2Bucket;
  }
}
