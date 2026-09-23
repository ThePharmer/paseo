import { describe, expect, it } from "vitest";
import {
  FILE_EDITOR_POLICY,
  resolveFileEditability,
  type FileEditability,
  type FileEditorPlatform,
} from "./policy";

function editability(input: {
  platform: FileEditorPlatform;
  size?: number;
  kind?: string;
  supportsEditing?: boolean;
  sessionOpen?: boolean;
  missing?: boolean;
}): FileEditability {
  return resolveFileEditability({
    platform: input.platform,
    supportsEditing: input.supportsEditing ?? true,
    file: input.missing ? null : { kind: input.kind ?? "text", size: input.size ?? 10 },
    sessionOpen: input.sessionOpen ?? false,
  });
}

describe("resolveFileEditability", () => {
  it("keeps the web limit at 1 MiB and the native limit at 512 KiB when an editor opens", () => {
    expect(editability({ platform: "web", size: 1024 * 1024 })).toBe("editable");
    expect(editability({ platform: "web", size: 1024 * 1024 + 1 })).toBe("tooLarge");
    expect(editability({ platform: "native", size: 512 * 1024 })).toBe("editable");
    expect(editability({ platform: "native", size: 512 * 1024 + 1 })).toBe("tooLarge");
  });

  it("keeps an open editor editable after its file grows past the limit", () => {
    expect(editability({ platform: "native", size: 600 * 1024, sessionOpen: true })).toBe(
      "editable",
    );
    expect(editability({ platform: "web", size: 2 * 1024 * 1024, sessionOpen: true })).toBe(
      "editable",
    );
  });

  it("keeps files read-only when the host cannot write them, even with an editor open", () => {
    expect(editability({ platform: "native", supportsEditing: false })).toBe("readOnly");
    expect(editability({ platform: "native", supportsEditing: false, size: 2 * 1024 * 1024 })).toBe(
      "readOnly",
    );
    expect(editability({ platform: "web", supportsEditing: false, sessionOpen: true })).toBe(
      "readOnly",
    );
  });

  it("only edits text files", () => {
    expect(editability({ platform: "web", kind: "image" })).toBe("readOnly");
    expect(editability({ platform: "web", missing: true })).toBe("readOnly");
  });
});

describe("FILE_EDITOR_POLICY", () => {
  it("opens web files in the editor and native files in the viewer with an Edit toggle", () => {
    expect(FILE_EDITOR_POLICY.web).toMatchObject({
      opensInEditor: true,
      hasEditToggle: false,
      savesOnBackground: false,
    });
    expect(FILE_EDITOR_POLICY.native).toMatchObject({
      opensInEditor: false,
      hasEditToggle: true,
      savesOnBackground: true,
    });
  });
});
