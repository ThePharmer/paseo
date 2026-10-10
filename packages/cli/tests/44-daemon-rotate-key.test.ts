#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { rotateDaemonKey, runRotateKeyCommand } from "../src/commands/daemon/rotate-key.ts";

console.log("=== Daemon Rotate Key Command ===\n");

const root = await mkdtemp(join(tmpdir(), "paseo-rotate-key-"));
const paseoHome = join(root, ".paseo");
const keypairPath = join(paseoHome, "daemon-keypair.json");

async function storedPublicKey(): Promise<string> {
  return JSON.parse(await readFile(keypairPath, "utf-8")).publicKeyB64;
}

try {
  await mkdir(paseoHome, { recursive: true });

  {
    console.log("Test 1: rotateDaemonKey replaces the stored key");
    const first = await rotateDaemonKey({ home: paseoHome });
    const before = await storedPublicKey();
    const second = await rotateDaemonKey({ home: paseoHome });
    const after = await storedPublicKey();

    assert.strictEqual(first.keypairPath, keypairPath);
    assert.notStrictEqual(after, before);
    assert.strictEqual(second.daemonRunning, false);
    assert.strictEqual(second.hubEnrolled, false);
    assert.match(second.message, /paseo daemon pair/);
    console.log("✓ rotate-key writes a new keypair\n");
  }

  {
    console.log("Test 2: reports a Hub enrollment");
    await writeFile(join(paseoHome, "hub-relationship.json"), "{}\n");
    const result = await rotateDaemonKey({ home: paseoHome });

    assert.strictEqual(result.hubEnrolled, true);
    assert.match(result.message, /Hub/);
    await rm(join(paseoHome, "hub-relationship.json"));
    console.log("✓ rotate-key mentions the Hub enrollment\n");
  }

  {
    console.log("Test 3: declining the prompt leaves the key unchanged");
    const before = await storedPublicKey();
    await assert.rejects(
      runRotateKeyCommand(
        {
          daemonTarget: { kind: "instance", home: paseoHome },
          confirmRotation: async () => false,
        },
        {} as Command,
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "KEY_ROTATION_CANCELLED",
    );
    assert.strictEqual(await storedPublicKey(), before);
    console.log("✓ declined rotation keeps the key\n");
  }

  {
    console.log("Test 4: piped stdin without --yes fails before rotating");
    const pipedHome = join(root, "piped");
    await mkdir(pipedHome, { recursive: true });
    const run = runLocalPaseo(["daemon", "rotate-key", "--home", pipedHome, "--json"]);
    run.stdin.end("y\n");
    const result = await run;

    assert.strictEqual(result.exitCode, 1, result.stderr);
    const error = JSON.parse(result.stderr).error as { code: string; details: string };
    assert.strictEqual(error.code, "KEY_ROTATION_CONFIRMATION_REQUIRED");
    assert.match(error.details, /--yes/);
    await assert.rejects(readFile(join(pipedHome, "daemon-keypair.json"), "utf-8"));
    console.log("✓ piped stdin requires --yes\n");
  }

  {
    console.log("Test 5: --yes rotates without a terminal");
    const before = await storedPublicKey();
    const run = runLocalPaseo(["daemon", "rotate-key", "--home", paseoHome, "--yes", "--json"]);
    run.stdin.end();
    const result = await run;

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.notStrictEqual(await storedPublicKey(), before);
    console.log("✓ --yes rotates non-interactively\n");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("=== Daemon Rotate Key Command Tests Passed ===");
