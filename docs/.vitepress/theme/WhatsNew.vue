<script setup lang="ts">
import { withBase } from "vitepress";
import { data as release } from "./release.data";

// What the latest release brought, from the changelog's own entries: see ../release.ts.
// VitePress puts an underscore before the id of a heading that starts with a digit.
const changelog = withBase(`/reference/upgrading#_${release.version.replaceAll(".", "-")}`);
</script>

<template>
  <section v-if="release.entries.length" id="new" class="tf-section tf-new">
    <h2>New in {{ release.line }}</h2>
    <p class="tf-lede">
      Version {{ release.version }}<template v-if="release.dated"> came out on {{ release.dated }}</template
      ><template v-else> is the latest</template>.
    </p>
    <ul class="tf-new-list">
      <li v-for="(entry, index) in release.entries" :key="index">
        <!-- The entries are this repository's own changelog, rendered when the site is built. -->
        <p v-html="entry.html" />
        <p v-if="entry.link || release.releases > 1" class="tf-new-meta">
          <span v-if="release.releases > 1" class="tf-new-version">{{ entry.version }}</span>
          <a v-if="entry.link" :href="withBase(entry.link.href)">{{ entry.link.text }}</a>
        </p>
      </li>
    </ul>
    <p class="tf-more">
      <template v-if="release.more">{{ release.more }} more in </template>
      <a :href="changelog">{{ release.more ? "the changelog" : "The changelog" }}</a
      ><template v-if="release.more">, which</template> has each change in full, and what to change in your code when one breaks something.
    </p>
  </section>
</template>

<style scoped>
.tf-new-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0 40px;
  border-bottom: 1px solid var(--tf-line);
}

@media (min-width: 900px) {
  .tf-new-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.tf-new-list li {
  margin: 0;
  padding: 18px 0;
  border-top: 1px solid var(--tf-line);
}

.tf-new-list p {
  margin: 0;
  line-height: 1.55;
  color: var(--tf-ink);
}

.tf-new-list .tf-new-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  font-size: 15px;
}

.tf-new-version {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--tf-slate);
}
</style>
