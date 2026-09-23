import { describe, expect, it } from "vitest";
import { FILE_EDITOR_POLICY, resolveFileEditability } from "./policy";

function text(size: number) {
  return { kind: "text", size };
}

describe("resolveFileEditability", () => {
  it("keeps the web limit at 1 MiB and the native limit at 512 KiB", () => {
    expect(
      resolveFileEditability({ platform: "web", supportsEditing: true, file: text(1024 * 1024) }),
    ).toBe("editable");
    expect(
      resolveFileEditability({
        platform: "web",
        supportsEditing: true,
        file: text(1024 * 1024 + 1),
      }),
    ).toBe("tooLarge");
    expect(
      resolveFileEditability({ platform: "native", supportsEditing: true, file: text(512 * 1024) }),
    ).toBe("editable");
    expect(
      resolveFileEditability({
        platform: "native",
        supportsEditing: true,
        file: text(512 * 1024 + 1),
      }),
    ).toBe("tooLarge");
  });

  it("keeps files read-only when the host cannot write them", () => {
    expect(
      resolveFileEditability({ platform: "native", supportsEditing: false, file: text(10) }),
    ).toBe("readOnly");
    expect(
      resolveFileEditability({
        platform: "native",
        supportsEditing: false,
        file: text(1024 * 1024 * 2),
      }),
    ).toBe("readOnly");
  });

  it("only edits text files", () => {
    expect(
      resolveFileEditability({
        platform: "web",
        supportsEditing: true,
        file: { kind: "image", size: 10 },
      }),
    ).toBe("readOnly");
    expect(resolveFileEditability({ platform: "web", supportsEditing: true, file: null })).toBe(
      "readOnly",
    );
  });
});

describe("FILE_EDITOR_POLICY", () => {
  it("opens web files in the editor and native files in the viewer with an Edit toggle", () => {
    expect(FILE_EDITOR_POLICY.web).toMatchObject({ opensInEditor: true, hasEditToggle: false });
    expect(FILE_EDITOR_POLICY.native).toMatchObject({ opensInEditor: false, hasEditToggle: true });
  });
});
