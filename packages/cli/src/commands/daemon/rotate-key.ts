import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { confirm, isCancel } from "@clack/prompts";
import { readDaemonInstance, resolvePaseoHome } from "@getpaseo/server/daemon-control";
import { daemonKeyPairPath, rotateDaemonKeyPair } from "@getpaseo/server/keypair";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

const HUB_RELATIONSHIP_FILENAME = "hub-relationship.json";

interface RotateKeyResult {
  action: "key_rotated";
  keypairPath: string;
  daemonRunning: boolean;
  hubEnrolled: boolean;
  restartCommand: string;
  message: string;
}

export type ConfirmRotation = () => Promise<boolean | symbol>;

export interface RotateKeyOptions {
  home?: string;
}

const rotateKeyResultSchema: OutputSchema<RotateKeyResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "KEYPAIR", field: "keypairPath" },
    { header: "RESTART", field: "restartCommand" },
  ],
  renderHuman: (result) => (result.data as RotateKeyResult).message,
};

function createCommandError(code: string, message: string, details?: string): CommandError {
  return { code, message, ...(details ? { details } : {}) };
}

function terminalConfirmRotation(): ConfirmRotation {
  if (!process.stdin.isTTY) {
    throw createCommandError(
      "KEY_ROTATION_CONFIRMATION_REQUIRED",
      "paseo daemon rotate-key needs confirmation",
      "Run it in an interactive terminal, or pass --yes.",
    );
  }
  return () =>
    confirm({
      message:
        "Rotate the daemon key? Every existing pairing link stops working and paired devices must pair again.",
      initialValue: false,
    });
}

function describeNextSteps(result: Omit<RotateKeyResult, "message">): string {
  const lines = [`New daemon keypair written to ${result.keypairPath}`];
  if (result.daemonRunning) {
    lines.push(
      "The running daemon still uses the old key. Restart it for the change to take effect.",
      `Run: ${result.restartCommand}`,
      "Then run `paseo daemon pair` and pair each device again.",
    );
  } else {
    lines.push(
      "The daemon uses the new key when it starts. Run `paseo daemon pair` to pair each device again.",
    );
  }
  if (result.hubEnrolled) {
    lines.push(
      "This daemon is enrolled with a Hub, which recorded the previous public key at enrollment.",
    );
  }
  return lines.join("\n");
}

export async function rotateDaemonKey(options: RotateKeyOptions = {}): Promise<RotateKeyResult> {
  const paseoHome = resolvePaseoHome({ PASEO_HOME: options.home });
  rotateDaemonKeyPair(paseoHome);
  const result = {
    action: "key_rotated" as const,
    keypairPath: daemonKeyPairPath(paseoHome),
    daemonRunning: (await readDaemonInstance(paseoHome)) !== null,
    hubEnrolled: existsSync(path.join(paseoHome, HUB_RELATIONSHIP_FILENAME)),
    restartCommand: `paseo daemon restart --home ${JSON.stringify(paseoHome)}`,
  };
  return { ...result, message: describeNextSteps(result) };
}

export async function runRotateKeyCommand(
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<RotateKeyResult>> {
  if (options.yes !== true) {
    const confirmRotation =
      typeof options.confirmRotation === "function"
        ? (options.confirmRotation as ConfirmRotation)
        : terminalConfirmRotation();
    const answer = await confirmRotation();
    if (isCancel(answer) || answer !== true) {
      throw createCommandError("KEY_ROTATION_CANCELLED", "Key rotation cancelled");
    }
  }
  const result = await rotateDaemonKey({
    home: options.daemonTarget.kind === "instance" ? options.daemonTarget.home : undefined,
  });

  return {
    type: "single",
    data: result,
    schema: rotateKeyResultSchema,
  };
}
