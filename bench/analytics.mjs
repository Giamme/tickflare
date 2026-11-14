// Asks Cloudflare's analytics what the benchmark Worker's Durable Objects were billed for, by
// namespace: the rooms that ticked, and the ones players only sat in.
//
// Needs CLOUDFLARE_API_TOKEN (with Account Analytics: Read), CLOUDFLARE_ACCOUNT_ID, WORKER, SINCE
// and UNTIL. Prints what came back, errors included: a token that may deploy Workers may well
// not be allowed to read analytics.
import { readFileSync } from "node:fs";

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, WORKER: script, SINCE: since } = process.env;
// Up to now: what is counted for an object can be dated a little after it was last used.
const until = new Date().toISOString();
let names = {};
try {
  names = Object.fromEntries(JSON.parse(readFileSync("namespaces.json", "utf8")).map(({ id, class: name }) => [id, name]));
} catch {
  // Namespaces are then reported by id.
}

async function ask(label, query) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { account, script, since, until } }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) {
    console.log(`ANALYTICS ${label}: refused (${response.status}) ${JSON.stringify(body?.errors ?? body).slice(0, 600)}`);
    return null;
  }
  return body.data?.viewer?.accounts?.[0] ?? null;
}

const periodic = await ask(
  "periodic",
  `query ($account: String!, $script: String!, $since: Time!, $until: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      durableObjectsPeriodicGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $script }) {
        dimensions { namespaceId }
        sum { activeTime cpuTime inboundWebsocketMsgCount outboundWebsocketMsgCount }
      }
    } }
  }`,
);
for (const group of periodic?.durableObjectsPeriodicGroups ?? []) {
  const { activeTime, cpuTime, inboundWebsocketMsgCount, outboundWebsocketMsgCount } = group.sum;
  console.log(
    "ANALYTICS " +
      JSON.stringify({
        kind: "periodic",
        namespace: names[group.dimensions.namespaceId] ?? group.dimensions.namespaceId,
        // Both are counted in microseconds.
        activeSeconds: +(activeTime / 1e6).toFixed(2),
        cpuSeconds: +(cpuTime / 1e6).toFixed(2),
        messagesIn: inboundWebsocketMsgCount,
        messagesOut: outboundWebsocketMsgCount,
      }),
  );
}
if (periodic && periodic.durableObjectsPeriodicGroups.length === 0) console.log("ANALYTICS periodic: nothing counted yet");

const invocations = await ask(
  "invocations",
  `query ($account: String!, $script: String!, $since: Time!, $until: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $script }) {
        dimensions { namespaceId }
        sum { requests wallTime }
      }
    } }
  }`,
);
for (const group of invocations?.durableObjectsInvocationsAdaptiveGroups ?? []) {
  console.log(
    "ANALYTICS " +
      JSON.stringify({
        kind: "invocations",
        namespace: names[group.dimensions.namespaceId] ?? group.dimensions.namespaceId,
        requests: group.sum.requests,
        wallSeconds: +(group.sum.wallTime / 1e6).toFixed(2),
      }),
  );
}
