import { ref } from "vue";

/** The id of the help text that is showing, so that opening one closes the other. */
export const openTip = ref<string | null>(null);
