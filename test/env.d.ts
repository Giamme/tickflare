declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "TestRoom" | "TickRoom" | "TurnRoom" | "TestMatchmaker" | "AwayRoom" | "PatientMatchmaker"
      | "EdgeRoom" | "LazyTickRoom" | "HalfRate" | "SlowLobby" | "FlakyLobby" | "NameRoom" | "AskedTurnRoom";
  }
  interface Env {
    ROOMS: DurableObjectNamespace<import("./worker").TestRoom>;
    TICKS: DurableObjectNamespace<import("./worker").TickRoom>;
    TURNS: DurableObjectNamespace<import("./worker").TurnRoom>;
    ASKED: DurableObjectNamespace<import("./worker").AskedTurnRoom>;
    AWAY: DurableObjectNamespace<import("./worker").AwayRoom>;
    SHAPES: DurableObjectNamespace<import("./worker").ShapesRoom>;
    PLAIN: DurableObjectNamespace<import("./worker").PlainShapesRoom>;
    SNAPS: DurableObjectNamespace<import("./worker").SnapRoom>;
    ASKEDSNAPS: DurableObjectNamespace<import("./worker").AskedSnapRoom>;
    PATIENT: DurableObjectNamespace<import("./worker").PatientMatchmaker>;
    MATCHMAKER: DurableObjectNamespace<import("./worker").TestMatchmaker>;
    EDGE: DurableObjectNamespace<import("./worker").EdgeRoom>;
    LAZY: DurableObjectNamespace<import("./worker").LazyTickRoom>;
    HALF: DurableObjectNamespace<import("./worker").HalfRate>;
    SLOW: DurableObjectNamespace<import("./worker").SlowLobby>;
    FLAKY: DurableObjectNamespace<import("./worker").FlakyLobby>;
    NAMES: DurableObjectNamespace<import("./worker").NameRoom>;
    MATCHES: Queue<import("../src/protocol.js").MatchResult>;
    DB: D1Database;
    REPLAYS: R2Bucket;
  }
}
