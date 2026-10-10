import { Command } from "commander";
import { startCommand, daemonRunCommand } from "./start.js";
import { daemonStatusCommand } from "./status.js";
import { daemonStopCommand } from "./stop.js";
import { daemonRestartCommand } from "./restart.js";
import { runRotateKeyCommand } from "./rotate-key.js";
import { runSetPasswordCommand } from "./set-password.js";
import { pairCommand } from "./pair.js";
import { daemonReloadCommand } from "./reload.js";
import { daemonConfigCommand } from "./config.js";
import { withOutput } from "../../output/index.js";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the Paseo daemon");
  for (const command of [
    startCommand(),
    daemonRunCommand(),
    daemonStatusCommand(),
    daemonStopCommand(),
    daemonRestartCommand(),
    daemonReloadCommand(),
    pairCommand(),
    daemonConfigCommand(),
  ])
    daemon.addCommand(command);
  addJsonOption(
    addLocalDaemonOptions(
      daemon.command("set-password").description("Save a hashed daemon password (local operation)"),
    ),
  ).action(withOutput(runSetPasswordCommand));
  addJsonOption(
    addLocalDaemonOptions(
      daemon
        .command("rotate-key")
        .description(
          "Replace the daemon keypair so existing pairing links stop working (local operation)",
        ),
    ),
  )
    .option("--yes", "Skip the confirmation prompt")
    .action(withOutput(runRotateKeyCommand));
  return daemon;
}
