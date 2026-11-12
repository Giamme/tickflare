import { ref } from "vue";

/** The two players of every demo. */
export type Who = "ada" | "grace";
export const who: Who[] = ["ada", "grace"];
export const names: Record<Who, string> = { ada: "Ada", grace: "Grace" };
export const hue: Record<Who, string> = { ada: "#ff4f36", grace: "#3d8bff" };
export const other = (player: Who): Who => (player === "ada" ? "grace" : "ada");

/** Which of the three demos the home page is showing. */
export type Mode = "event" | "sync" | "lockstep";
export const mode = ref<Mode>("sync");
