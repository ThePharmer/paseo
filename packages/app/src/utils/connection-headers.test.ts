import { describe, expect, it } from "vitest";
import {
  ConnectionHeaderTargetBinding,
  directConnectionTargetKey,
  normalizeConnectionHeadersRecord,
  prepareConnectionHeaders,
} from "./connection-headers";

describe("prepareConnectionHeaders", () => {
  it("trims and returns custom headers", () => {
    expect(
      prepareConnectionHeaders([
        { id: 1, name: " X-Tenant ", value: " acme " },
        { id: 2, name: "X-Empty", value: "" },
      ]),
    ).toEqual({ headers: { "X-Tenant": "acme", "X-Empty": "" } });
  });

  it("ignores completely empty draft rows", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "", value: "" }])).toEqual({});
  });

  it("requires a name when a value is entered", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "", value: "acme" }])).toEqual({
      issue: { type: "missingName" },
    });
  });

  it("rejects invalid and duplicate names case-insensitively", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "Bad Header", value: "value" }])).toEqual({
      issue: { type: "invalidName", name: "Bad Header" },
    });
    expect(
      prepareConnectionHeaders([
        { id: 1, name: "X-Tenant", value: "one" },
        { id: 2, name: "x-tenant", value: "two" },
      ]),
    ).toEqual({ issue: { type: "duplicateName", name: "x-tenant" } });
  });

  it("rejects __proto__ instead of silently dropping it", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "__proto__", value: "x" }])).toEqual({
      issue: { type: "invalidName", name: "__proto__" },
    });
    expect(prepareConnectionHeaders([{ id: 1, name: "__PROTO__", value: "x" }])).toEqual({
      issue: { type: "invalidName", name: "__PROTO__" },
    });
  });

  it("rejects line breaks in values", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "X-Test", value: "one\ntwo" }])).toEqual({
      issue: { type: "invalidValue", name: "X-Test" },
    });
  });
});

describe("normalizeConnectionHeadersRecord", () => {
  it("accepts a valid persisted string record", () => {
    expect(normalizeConnectionHeadersRecord({ "X-Tenant": "acme" })).toEqual({
      "X-Tenant": "acme",
    });
  });

  it("rejects malformed persisted header values", () => {
    expect(normalizeConnectionHeadersRecord({ "X-Tenant": 42 })).toBeUndefined();
    expect(
      normalizeConnectionHeadersRecord({ "X-Tenant": "acme\r\nX-Injected: true" }),
    ).toBeUndefined();
  });
});

describe("directConnectionTargetKey", () => {
  it("ignores host casing and the password", () => {
    expect(directConnectionTargetKey("tcp://A.Example.Test:6767?password=one")).toBe(
      directConnectionTargetKey("tcp://a.example.test:6767"),
    );
  });

  it("distinguishes host, port, and SSL", () => {
    const base = directConnectionTargetKey("tcp://a.example.test:6767");
    expect(directConnectionTargetKey("tcp://b.example.test:6767")).not.toBe(base);
    expect(directConnectionTargetKey("tcp://a.example.test:7000")).not.toBe(base);
    expect(directConnectionTargetKey("tcp://a.example.test:6767?ssl=true")).not.toBe(base);
  });

  it("returns null for anything that is not a complete direct URI", () => {
    expect(directConnectionTargetKey("")).toBeNull();
    expect(directConnectionTargetKey("tcp://a.example.test")).toBeNull();
    expect(directConnectionTargetKey("relay://relay.example.test:443/srv?key=abc")).toBeNull();
  });
});

describe("ConnectionHeaderTargetBinding", () => {
  it("binds to the target of the first content edit", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit("a");
    binding.noteContentEdit("a");
    expect(binding.isStaleFor("a")).toBe(false);
    expect(binding.isStaleFor("b")).toBe(true);
    expect(binding.isStaleFor(null)).toBe(true);
  });

  it("invalidates the whole batch when content is edited for another target", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit("a");
    binding.noteContentEdit("b");
    expect(binding.isStaleFor("a")).toBe(true);
    expect(binding.isStaleFor("b")).toBe(true);
    binding.noteContentEdit("a");
    expect(binding.isStaleFor("a")).toBe(true);
  });

  it("treats a content edit without a known target as another target once bound", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit("a");
    binding.noteContentEdit(null);
    expect(binding.isStaleFor("a")).toBe(true);
  });

  it("stays unbound while content is edited without a known target", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit(null);
    expect(binding.isStaleFor("a")).toBe(false);
    binding.noteContentEdit("b");
    expect(binding.isStaleFor("a")).toBe(true);
    expect(binding.isStaleFor("b")).toBe(false);
  });

  it("binds an unbound batch to the target it is sent to", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit(null);
    binding.bindToConnectTarget("a");
    expect(binding.isStaleFor("a")).toBe(false);
    expect(binding.isStaleFor("b")).toBe(true);
  });

  it("leaves an existing binding alone when sent", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit("a");
    binding.bindToConnectTarget("b");
    expect(binding.isStaleFor("a")).toBe(false);
  });

  it("forgets the target and the invalid state on reset", () => {
    const binding = new ConnectionHeaderTargetBinding();
    binding.noteContentEdit("a");
    binding.noteContentEdit("b");
    binding.reset();
    expect(binding.isStaleFor("c")).toBe(false);
  });
});
