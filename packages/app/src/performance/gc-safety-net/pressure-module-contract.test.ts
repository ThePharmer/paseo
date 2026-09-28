import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BALLOON_FUNCTION_NAMES, BALLOON_GLOBAL_NAME } from "./balloon-finalizer";

// The native side has no test harness in this repo and first compiles in the
// APK build. These checks keep the names JS calls in step with the names the
// Kotlin module declares, the JNI symbol it binds, and the JSI global the C++
// installs.
const MODULE_DIR = path.resolve(__dirname, "../../../modules/paseo-gc-pressure");

function readModuleFile(relativePath: string): string {
  return readFileSync(path.join(MODULE_DIR, relativePath), "utf8");
}

const KOTLIN_SOURCE = readModuleFile(
  "android/src/main/java/sh/paseo/gcpressure/PaseoGcPressureModule.kt",
);
const CPP_SOURCE = readModuleFile("cpp/balloon-finalizer.cpp");
const CMAKE_SOURCE = readModuleFile("android/CMakeLists.txt");

describe("PaseoGcPressure native contract", () => {
  test("the Kotlin module declares the functions index.android.ts calls", () => {
    expect(KOTLIN_SOURCE).toContain('Name("PaseoGcPressure")');
    expect(KOTLIN_SOURCE).toContain('Function("nativeHeapBytes")');
    expect(KOTLIN_SOURCE).toContain('Function("installBalloonFinalizer")');
  });

  test("the Kotlin external function binds the JNI symbol the C++ exports", () => {
    expect(KOTLIN_SOURCE).toContain(
      "private external fun nativeInstallBalloonFinalizer(runtimePointer: Long): Boolean",
    );
    expect(CPP_SOURCE).toMatch(
      /extern "C" JNIEXPORT jboolean JNICALL\s+Java_sh_paseo_gcpressure_PaseoGcPressureModule_nativeInstallBalloonFinalizer\(\s*JNIEnv\*, jobject, jlong runtimePointer\)/,
    );
  });

  test("Kotlin loads the library CMake builds", () => {
    expect(CMAKE_SOURCE).toContain(
      "add_library(paseo_gc_pressure SHARED ../cpp/balloon-finalizer.cpp)",
    );
    expect(KOTLIN_SOURCE).toContain('System.loadLibrary("paseo_gc_pressure")');
  });

  test("the C++ installs the global and functions the JS side reads", () => {
    expect(CPP_SOURCE).toContain(`constexpr const char* kGlobalName = "${BALLOON_GLOBAL_NAME}";`);
    for (const name of BALLOON_FUNCTION_NAMES) {
      expect(CPP_SOURCE).toMatch(
        new RegExp(
          `api\\.setProperty\\(\\s*runtime,\\s*"${name}",\\s*makeFunction\\(\\s*runtime,\\s*"${name}",`,
        ),
      );
    }
  });
});
