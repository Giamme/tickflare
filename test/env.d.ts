declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TestRoom" | "TickRoom" | "TurnRoom" | "TestMatchmaker" | "AwayRoom" | "PatientMatchmaker"
      | "EdgeRoom" | "LazyTickRoom" | "HalfRate" | "SlowLobby" | "FlakyLobby";
  }
  interface Env {
    ROOMS: DurableObjectNamespace<import("./worker").TestRoom>;
    TICKS: DurableObjectNamespace<import("./worker").TickRoom>;
    TURNS: DurableObjectNamespace<import("./worker").TurnRoom>;
    AWAY: DurableObjectNamespace<import("./worker").AwayRoom>;
    PATIENT: DurableObjectNamespace<import("./worker").PatientMatchmaker>;
    MATCHMAKER: DurableObjectNamespace<import("./worker").TestMatchmaker>;
    EDGE: DurableObjectNamespace<import("./worker").EdgeRoom>;
    LAZY: DurableObjectNamespace<import("./worker").LazyTickRoom>;
    HALF: DurableObjectNamespace<import("./worker").HalfRate>;
    SLOW: DurableObjectNamespace<import("./worker").SlowLobby>;
    FLAKY: DurableObjectNamespace<import("./worker").FlakyLobby>;
    MATCHES: Queue<import("../src/protocol.js").MatchResult>;
    DB: D1Database;
    REPLAYS: R2Bucket;
  }
}
