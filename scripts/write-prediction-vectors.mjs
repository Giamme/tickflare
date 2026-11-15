// Writes test/vectors/prediction.json from test/vectors/prediction.ts, with the TypeScript client.
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "tickflare-vectors-")), "prediction.mjs");
await build({ entryPoints: ["test/vectors/prediction.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning" });
const { predictionCases, interpolationCases } = await import(pathToFileURL(out).href);
const vectors = { prediction: await predictionCases(), interpolation: interpolationCases() };
writeFileSync("test/vectors/prediction.json", JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${vectors.prediction.length} prediction and ${vectors.interpolation.length} interpolation cases`);
