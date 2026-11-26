import "@fontsource-variable/recursive/casl.css";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import CloudflareStack from "./CloudflareStack.vue";
import CostEstimator from "./CostEstimator.vue";
import HomeHero from "./HomeHero.vue";
import SyncModes from "./SyncModes.vue";
import WhatsNew from "./WhatsNew.vue";
import "./custom.css";
import "./demo/demo.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("CloudflareStack", CloudflareStack);
    app.component("CostEstimator", CostEstimator);
    app.component("HomeHero", HomeHero);
    app.component("SyncModes", SyncModes);
    app.component("WhatsNew", WhatsNew);
  },
} satisfies Theme;
