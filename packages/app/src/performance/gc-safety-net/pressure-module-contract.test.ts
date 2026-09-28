import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// The native module has no Kotlin test harness in this repo, and JS cannot
// observe whether Expo's JavaScriptObject wrapper still roots the balloon. This
// guards the one line that decides it: setPressure must release the wrapper
// on every call, or the balloon stays strongly reachable until Java finalizes
// it and no Hermes collection can free it.
const MODULE_SOURCE_PATH = path.resolve(
  __dirname,
  "../../../modules/paseo-gc-pressure/android/src/main/java/sh/paseo/gcpressure/PaseoGcPressureModule.kt",
);

function readSetPressureBody(source: string): string {
  const start = source.indexOf('Function("setPressure")');
  if (start === -1) {
    throw new Error("setPressure is not declared in PaseoGcPressureModule.kt");
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  throw new Error("setPressure body is not closed");
}

describe("PaseoGcPressure.setPressure native contract", () => {
  test("releases the JavaScriptObject wrapper in a finally block", () => {
    const body = readSetPressureBody(readFileSync(MODULE_SOURCE_PATH, "utf8"));
    const finallyBlock = body.slice(body.indexOf("finally"));

    expect(body).toMatch(/target: JavaScriptObject/);
    expect(body.indexOf("finally")).toBeGreaterThan(body.indexOf("setExternalMemoryPressure"));
    expect(finallyBlock).toMatch(/^finally \{\s*target\.deallocate\(\)\s*\}/);
  });
});
