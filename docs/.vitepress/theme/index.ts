import "@fontsource-variable/recursive/casl.css";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import CloudflareStack from "./CloudflareStack.vue";
import CostCompare from "./CostCompare.vue";
import HomeHero from "./HomeHero.vue";
import SyncModes from "./SyncModes.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("CloudflareStack", CloudflareStack);
    app.component("CostCompare", CostCompare);
    app.component("HomeHero", HomeHero);
    app.component("SyncModes", SyncModes);
  },
} satisfies Theme;
