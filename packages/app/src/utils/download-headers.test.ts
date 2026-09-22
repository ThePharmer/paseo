import { describe, expect, it } from "vitest";
import { buildDownloadHeaders } from "./download-headers";

describe("buildDownloadHeaders", () => {
  it("returns undefined without custom headers or authorization", () => {
    expect(buildDownloadHeaders(undefined, null)).toBeUndefined();
    expect(buildDownloadHeaders({}, null)).toBeUndefined();
  });

  it("passes custom headers through unchanged", () => {
    expect(
      buildDownloadHeaders({ "CF-Access-Client-Id": "abc", "X-Tenant": "acme" }, null),
    ).toEqual({ "CF-Access-Client-Id": "abc", "X-Tenant": "acme" });
  });

  it("returns only the derived authorization when there are no custom headers", () => {
    expect(buildDownloadHeaders(undefined, "Basic dXNlcjpwYXNz")).toEqual({
      Authorization: "Basic dXNlcjpwYXNz",
    });
  });

  it("sends custom headers alongside the derived authorization", () => {
    expect(buildDownloadHeaders({ "CF-Access-Client-Id": "abc" }, "Basic dXNlcjpwYXNz")).toEqual({
      "CF-Access-Client-Id": "abc",
      Authorization: "Basic dXNlcjpwYXNz",
    });
  });

  it("replaces a custom authorization entry under any casing", () => {
    expect(buildDownloadHeaders({ authorization: "Bearer custom" }, "Basic derived")).toEqual({
      Authorization: "Basic derived",
    });
    expect(buildDownloadHeaders({ AUTHORIZATION: "Bearer custom" }, "Basic derived")).toEqual({
      Authorization: "Basic derived",
    });
    expect(buildDownloadHeaders({ Authorization: "Bearer custom" }, "Basic derived")).toEqual({
      Authorization: "Basic derived",
    });
  });

  it("keeps a custom authorization entry when no authorization is derived", () => {
    expect(buildDownloadHeaders({ authorization: "Bearer custom" }, null)).toEqual({
      authorization: "Bearer custom",
    });
  });

  it("keeps the original casing of custom header names", () => {
    expect(Object.keys(buildDownloadHeaders({ "cf-Access-CLIENT-Id": "abc" }, null) ?? {})).toEqual(
      ["cf-Access-CLIENT-Id"],
    );
  });
});
