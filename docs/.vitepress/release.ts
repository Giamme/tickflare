import { readFileSync } from "node:fs";

/*
 * What the site says about the latest release, read from the two files a release writes: the
 * version in package.json and the entries in .changelog/changelog.json. Nothing here is edited
 * by hand, so the navigation and the home page are right for every release the moment the site
 * is built from it.
 */

/** One entry of a release, cut down to what the home page shows of it. */
export interface ReleaseEntry {
  /** The entry's first sentence, as Markdown. */
  text: string;
  /** The version it came out in. */
  version: string;
  /** The page of this site the entry sends its reader to, under the name the entry gives it. */
  link?: { text: string; href: string };
}

/** The latest release, with the entries of every release in its line (0.3.0, 0.3.1, …). */
export interface Release {
  /** The latest version, as in package.json: `0.3.0`. */
  version: string;
  /** Its line: `0.3`. */
  line: string;
  /** The day the latest version came out, `2026-11-26`. Empty when the changelog does not know the version. */
  date: string;
  /** How many releases the line has had. */
  releases: number;
  /** The line's entries, the newest release first and what a release features first, up to the limit asked for. */
  entries: ReleaseEntry[];
  /** How many more entries the line has than `entries` holds. */
  more: number;
}

interface ChangelogEntry {
  text: string;
  audience?: string;
  highlight?: boolean;
}

interface ChangelogVersion {
  version: string;
  date?: string;
  entries?: ChangelogEntry[];
}

const SITE = "https://tickflare.gridpaper.dev";
const root = new URL("../../", import.meta.url);

function read<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;
}

function lineOf(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function newestFirst(a: ChangelogVersion, b: ChangelogVersion): number {
  const [x, y] = [a, b].map((v) => v.version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0));
  for (let i = 0; i < 3; i++) {
    if ((x![i] ?? 0) !== (y![i] ?? 0)) return (y![i] ?? 0) - (x![i] ?? 0);
  }
  return 0;
}

/** Past this many characters, a first sentence with a colon in it is cut at the colon. */
const LONG_SENTENCE = 160;

/**
 * The first sentence of an entry: up to the first full stop that ends one. A full stop inside
 * code (`RoomClient.send()`), inside brackets, or inside a number (0.2) does not. A long sentence
 * that says what changed and then, after a colon, how, is kept up to the colon.
 */
export function firstSentence(text: string): string {
  let code = false;
  let depth = 0;
  let colon = -1;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const closes = i + 1 === text.length || /\s/.test(text[i + 1]!);
    if (char === "`") code = !code;
    else if (code) continue;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0 && closes && colon < 0) colon = i;
    else if (char === "." && depth === 0 && closes) {
      end = i + 1;
      break;
    }
  }
  const sentence = text.slice(0, end).trim();
  return sentence.length > LONG_SENTENCE && colon > 0 ? `${text.slice(0, colon)}.` : sentence;
}

/** The last link in an entry to a page of this site, which by habit is its "See [the guide](…)". */
function siteLink(text: string): ReleaseEntry["link"] {
  const links = [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].filter((match) => match[2]!.startsWith(`${SITE}/`));
  const last = links.at(-1);
  return last ? { text: last[1]!, href: last[2]!.slice(SITE.length) } : undefined;
}

/** Reads the latest release from the repository the site is built from. */
export function readRelease(limit = 8): Release {
  const { version } = read<{ version: string }>("package.json");
  const all = read<{ versions: ChangelogVersion[] }>(".changelog/changelog.json").versions;
  const line = lineOf(version);
  const inLine = all.filter((release) => lineOf(release.version) === line).sort(newestFirst);
  const entries = inLine.flatMap((release) => {
    const shown = (release.entries ?? []).filter((entry) => entry.audience !== "internal");
    // What a release features comes first, as in the changelog; the rest keep their order.
    return [...shown.filter((entry) => entry.highlight), ...shown.filter((entry) => !entry.highlight)].map(
      (entry): ReleaseEntry => ({ text: firstSentence(entry.text), version: release.version, link: siteLink(entry.text) }),
    );
  });
  return {
    version,
    line,
    date: all.find((release) => release.version === version)?.date ?? "",
    releases: inLine.length,
    entries: entries.slice(0, limit),
    more: Math.max(0, entries.length - limit),
  };
}
