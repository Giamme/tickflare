// Asks Cloudflare's analytics what the benchmark Worker's Durable Objects were billed for, by
// namespace: the rooms that ticked, and the ones players only sat in.
//
// Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and SINCE, and the namespaces to ask about in
// NAMESPACES or namespaces.json. Prints what came back, errors included: a token that may
// deploy Workers may not be allowed to read analytics. `--describe` prints what the two
// datasets can be filtered and summed by.
import { readFileSync } from "node:fs";

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, SINCE: since } = process.env;
// Far enough ahead to take in whatever is counted while this waits.
const until = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
// The namespaces to ask about, as [{ id, class }]: from the environment, or as the workflow listed them.
let namespaces = [];
try {
  namespaces = JSON.parse(process.env.NAMESPACES || readFileSync("namespaces.json", "utf8"));
} catch {
  // None, then.
}
const names = Object.fromEntries(namespaces.map(({ id, class: name }) => [id, name]));
const ids = JSON.stringify(namespaces.map(({ id }) => id));

async function ask(label, query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) {
    console.log(`ANALYTICS ${label}: refused (${response.status}) ${JSON.stringify(body?.errors ?? body).slice(0, 600)}`);
    return null;
  }
  return body.data;
}

if (process.argv.includes("--describe")) {
  // What the two datasets can be filtered and summed by, straight from the schema.
  const REF = "name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } }";
  const named = (type) => {
    while (type && !type.name) type = type.ofType;
    return type?.name;
  };
  const typeOf = async (name) =>
    (await ask(name, `{ __type(name: "${name}") { fields { name type { ${REF} } } inputFields { name } } }`))?.__type;
  const root = await ask("schema", `{ __type(name: "account") { fields { name args { name type { ${REF} } } type { ${REF} } } } }`);
  for (const field of root?.__type?.fields ?? []) {
    if (!/^durableObjects(Periodic|InvocationsAdaptive)Groups$/.test(field.name)) continue;
    const parts = {};
    for (const part of (await typeOf(named(field.type)))?.fields ?? []) {
      parts[part.name] = (await typeOf(named(part.type)))?.fields?.map((f) => f.name) ?? named(part.type);
    }
    const filter = field.args.find((arg) => arg.name === "filter");
    const filters = (await typeOf(named(filter?.type)))?.inputFields?.map((f) => f.name) ?? [];
    console.log(
      "ANALYTICS " +
        JSON.stringify({
          dataset: field.name,
          row: named(field.type),
          parts,
          filters: filters.filter((name) => !/_(neq|gt|lt|leq|geq|like|notlike|notin|in)$/.test(name)),
        }).slice(0, 6000),
    );
  }
  process.exit(0);
}

const window = `datetime_geq: "${since}", datetime_leq: "${until}", namespaceId_in: ${ids}`;
const accounts = (data) => data?.viewer?.accounts?.[0] ?? null;
const seconds = (microseconds) => +(microseconds / 1e6).toFixed(3);

// The analytics lag by some minutes. Wait until they have something, and until two looks a
// minute apart find the same: what a room is counted for comes in over a while.
const patience = Number(process.env.WAIT_SECONDS ?? 0);
if (patience > 0) {
  const count = async () => {
    const data = accounts(
      await ask(
        "waiting",
        `{ viewer { accounts(filter: { accountTag: "${account}" }) {
          durableObjectsPeriodicGroups(limit: 1000, filter: { ${window} }) {
            dimensions { objectId } sum { activeTime }
          }
        } } }`,
      ),
    );
    const groups = data?.durableObjectsPeriodicGroups ?? [];
    return `${groups.length}:${groups.reduce((total, group) => total + group.sum.activeTime, 0)}`;
  };
  const started = Date.now();
  let last = "";
  while (Date.now() - started < patience * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    const now = await count();
    console.log(`after ${Math.round((Date.now() - started) / 1000)} s: ${now.split(":")[0]} objects counted`);
    if (!now.startsWith("0:") && now === last) break;
    last = now;
  }
}

// By object: `name` is the room's id, which the load script printed with what it measured there.
const periodic = accounts(
  await ask(
    "periodic",
    `{ viewer { accounts(filter: { accountTag: "${account}" }) {
      durableObjectsPeriodicGroups(limit: 1000, filter: { ${window} }) {
        dimensions { namespaceId name objectId coloCode }
        sum { activeTime cpuTime duration rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount }
        max { activeWebsocketConnections }
      }
    } } }`,
  ),
);
for (const group of periodic?.durableObjectsPeriodicGroups ?? []) {
  const { dimensions, sum, max } = group;
  console.log(
    "ANALYTICS " +
      JSON.stringify({
        kind: "periodic",
        class: names[dimensions.namespaceId] ?? dimensions.namespaceId,
        room: dimensions.name || dimensions.objectId.slice(0, 8),
        colo: dimensions.coloCode,
        // Counted in microseconds.
        activeSeconds: seconds(sum.activeTime),
        cpuSeconds: seconds(sum.cpuTime),
        // What is billed, in gigabyte-seconds.
        duration: +sum.duration.toFixed(3),
        rowsWritten: sum.rowsWritten,
        messagesIn: sum.inboundWebsocketMsgCount,
        messagesOut: sum.outboundWebsocketMsgCount,
        sockets: max.activeWebsocketConnections,
      }),
  );
}
if (periodic && periodic.durableObjectsPeriodicGroups.length === 0) console.log("ANALYTICS periodic: nothing counted yet");

const invocations = accounts(
  await ask(
    "invocations",
    `{ viewer { accounts(filter: { accountTag: "${account}" }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { ${window} }) {
        dimensions { namespaceId name objectId type }
        sum { requests errors wallTime }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    } } }`,
  ),
);
for (const group of invocations?.durableObjectsInvocationsAdaptiveGroups ?? []) {
  const { dimensions, sum, quantiles } = group;
  console.log(
    "ANALYTICS " +
      JSON.stringify({
        kind: "invocations",
        class: names[dimensions.namespaceId] ?? dimensions.namespaceId,
        room: dimensions.name || dimensions.objectId.slice(0, 8),
        type: dimensions.type,
        requests: sum.requests,
        errors: sum.errors,
        wallSeconds: seconds(sum.wallTime),
        cpuP50: quantiles.cpuTimeP50,
        cpuP99: quantiles.cpuTimeP99,
      }),
  );
}
if (invocations && invocations.durableObjectsInvocationsAdaptiveGroups.length === 0) console.log("ANALYTICS invocations: nothing counted yet");
