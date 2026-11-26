import { createMarkdownRenderer, defineLoader, type SiteConfig } from "vitepress";
import { readRelease, type Release, type ReleaseEntry } from "../release";

/** The latest release as the home page shows it: each entry's first sentence as HTML, and the date written out. */
export interface ReleaseData extends Omit<Release, "entries"> {
  /** The day the latest version came out, as `26 November 2026`. */
  dated: string;
  entries: Array<Omit<ReleaseEntry, "text"> & { html: string }>;
}

declare const data: ReleaseData;
export { data };

export default defineLoader({
  // Both are written by the release commit, so a build of that commit shows that release.
  watch: ["../../../package.json", "../../../.changelog/changelog.json"],
  async load(): Promise<ReleaseData> {
    const config = (globalThis as unknown as { VITEPRESS_CONFIG: SiteConfig }).VITEPRESS_CONFIG;
    const markdown = await createMarkdownRenderer(config.srcDir, config.markdown, config.site.base, config.logger);
    const release = readRelease();
    return {
      ...release,
      dated: release.date
        ? new Date(`${release.date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
        : "",
      entries: release.entries.map(({ text, ...entry }) => ({ ...entry, html: markdown.renderInline(text) })),
    };
  },
});
