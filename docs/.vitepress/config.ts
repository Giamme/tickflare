import { readFileSync } from "node:fs";
import { defineConfig, type DefaultTheme } from "vitepress";

/** The API reference sidebar TypeDoc writes, as one group per entry point: `tickflare`, then `tickflare/client`. */
function apiSidebar(): DefaultTheme.SidebarItem[] {
  const generated = JSON.parse(readFileSync(new URL("../api/typedoc-sidebar.json", import.meta.url), "utf8")) as DefaultTheme.SidebarItem[];
  const all = (items: DefaultTheme.SidebarItem[]): DefaultTheme.SidebarItem[] =>
    items.flatMap((item) => [item, ...all(item.items ?? [])]);
  const flat = all(generated);
  const server = flat.find((item) => item.link === "/api/tickflare/");
  const client = flat.find((item) => item.link === "/api/tickflare/client/");
  return [
    { text: "tickflare", link: "/api/tickflare/", collapsed: false, items: server?.items ?? [] },
    { text: "tickflare/client", link: "/api/tickflare/client/", collapsed: false, items: client?.items ?? [] },
  ];
}

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: "Start here",
    items: [
      { text: "What Tickflare is", link: "/guide/introduction" },
      { text: "Getting started", link: "/guide/getting-started" },
      { text: "Examples", link: "/guide/examples" },
    ],
  },
  {
    text: "Rooms",
    items: [
      { text: "Rooms and hooks", link: "/guide/rooms" },
      { text: "Players and seats", link: "/guide/players" },
      { text: "State and views", link: "/guide/state-and-views" },
      { text: "Timers, messages and async work", link: "/guide/timers-messages-async" },
    ],
  },
  {
    text: "Sync modes",
    items: [
      { text: "Choosing a mode", link: "/guide/sync-modes" },
      { text: "State sync", link: "/guide/state-sync" },
      { text: "Lockstep", link: "/guide/lockstep" },
    ],
  },
  {
    text: "Around the room",
    items: [
      { text: "Identity and join tokens", link: "/guide/identity" },
      { text: "Accounts and player data", link: "/guide/accounts" },
      { text: "Matchmaking", link: "/guide/matchmaking" },
      { text: "Match results and replays", link: "/guide/match-results" },
      { text: "Worlds across rooms", link: "/guide/worlds" },
    ],
  },
  {
    text: "Client",
    items: [{ text: "Connecting from the client", link: "/guide/client" }],
  },
  {
    text: "Shipping",
    items: [
      { text: "Deploying", link: "/guide/deploying" },
      { text: "What it costs", link: "/guide/costs" },
      { text: "Testing your rooms", link: "/guide/testing" },
      { text: "Limits", link: "/guide/limits" },
    ],
  },
];

const reference: DefaultTheme.SidebarItem[] = [
  {
    text: "Reference",
    items: [
      { text: "Wire protocol", link: "/reference/protocol" },
      { text: "Accounts HTTP API", link: "/reference/accounts-http" },
      { text: "Upgrading to 0.1", link: "/reference/upgrading" },
    ],
  },
];

export default defineConfig({
  title: "Tickflare",
  description: "A multiplayer game framework for Cloudflare Workers and Durable Objects.",
  cleanUrls: true,
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: true,
  head: [["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }]],
  markdown: { theme: { light: "github-light", dark: "github-dark" } },
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "^/guide/" },
      { text: "Reference", link: "/reference/protocol", activeMatch: "^/reference/" },
      { text: "API", link: "/api/", activeMatch: "^/api/" },
      { text: "Changelog", link: "https://github.com/Giamme/tickflare/blob/main/CHANGELOG.md" },
    ],
    sidebar: {
      "/guide/": guide,
      "/reference/": reference,
      "/api/": apiSidebar(),
    },
    socialLinks: [{ icon: "github", link: "https://github.com/Giamme/tickflare" }],
    editLink: {
      pattern: "https://github.com/Giamme/tickflare/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: "MIT licence. Tickflare is an independent project and is not affiliated with Cloudflare.",
    },
  },
});
