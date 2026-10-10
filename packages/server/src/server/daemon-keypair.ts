import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
  type KeyPair,
} from "@getpaseo/relay/e2ee";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";

const KeyPairSchema = z.object({
  v: z.literal(2),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
});

type StoredKeyPair = z.infer<typeof KeyPairSchema>;

const KEYPAIR_FILENAME = "daemon-keypair.json";

export interface DaemonKeyPairBundle {
  keyPair: KeyPair;
  publicKeyB64: string;
}

export async function loadOrCreateDaemonKeyPair(
  paseoHome: string,
  logger?: pino.Logger,
): Promise<DaemonKeyPairBundle> {
  const log = logger?.child({ module: "daemon-keypair" });
  const filePath = daemonKeyPairPath(paseoHome);

  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const raw = readFileSync(filePath, "utf8");
      const parsed = KeyPairSchema.parse(JSON.parse(raw));

      const publicKey = importPublicKey(parsed.publicKeyB64);
      const secretKey = importSecretKey(parsed.secretKeyB64);
      const publicKeyB64 = exportPublicKey(publicKey);

      log?.info({ filePath }, "Loaded daemon keypair");
      return { keyPair: { publicKey, secretKey }, publicKeyB64 };
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
    }
  }

  const bundle = writeNewDaemonKeyPair(filePath);
  log?.info({ filePath }, "Saved daemon keypair");
  return bundle;
}

export function daemonKeyPairPath(paseoHome: string): string {
  return path.join(paseoHome, KEYPAIR_FILENAME);
}

/**
 * Replaces the daemon keypair. Every existing pairing link stops working, and a
 * running daemon keeps the old key until it restarts.
 */
export function rotateDaemonKeyPair(paseoHome: string): DaemonKeyPairBundle {
  return writeNewDaemonKeyPair(daemonKeyPairPath(paseoHome));
}

function writeNewDaemonKeyPair(filePath: string): DaemonKeyPairBundle {
  const keyPair = generateKeyPair();
  const publicKeyB64 = exportPublicKey(keyPair.publicKey);
  const payload: StoredKeyPair = {
    v: 2,
    publicKeyB64,
    secretKeyB64: exportSecretKey(keyPair.secretKey),
  };
  writePrivateFileAtomicSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  return { keyPair, publicKeyB64 };
}
