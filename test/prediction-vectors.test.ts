import { describe, expect, it } from "vitest";
import written from "./vectors/prediction.json";
import { interpolationCases, predictionCases } from "./vectors/prediction.js";

/**
 * The engine clients replay test/vectors/prediction.json. This checks that it
 * says what the TypeScript client does: if the client changes, write the file
 * again with `node scripts/write-prediction-vectors.mjs`.
 */
describe("the prediction and interpolation test cases", () => {
  it("are what the TypeScript client does", async () => {
    expect(written).toEqual(JSON.parse(JSON.stringify({ prediction: await predictionCases(), interpolation: interpolationCases() })));
  });
});
