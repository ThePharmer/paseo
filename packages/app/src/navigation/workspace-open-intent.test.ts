import { describe, expect, it } from "vitest";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { canRouteConsumeWorkspaceOpenIntent } from "./workspace-open-intent";

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";

function routeInput(overrides: {
  openValue?: string;
  isRouteFocused?: boolean;
  pathname?: string;
  workspaceId?: string;
}) {
  return {
    openValue: overrides.openValue ?? "agent:agent-b",
    isRouteFocused: overrides.isRouteFocused ?? true,
    pathname: overrides.pathname ?? buildHostWorkspaceRoute("srv", WORKSPACE_B),
    serverId: "srv",
    workspaceId: overrides.workspaceId ?? WORKSPACE_B,
  };
}

describe("canRouteConsumeWorkspaceOpenIntent", () => {
  it("lets the focused route for the workspace on screen consume its own intent", () => {
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({}))).toBe(true);
  });

  it("does nothing without an open intent", () => {
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({ openValue: "" }))).toBe(false);
  });

  it("keeps an unfocused route from consuming the intent", () => {
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({ isRouteFocused: false }))).toBe(false);
  });

  it("keeps a route for another workspace from consuming the intent on screen", () => {
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({ workspaceId: WORKSPACE_A }))).toBe(
      false,
    );
  });

  it("keeps a route from consuming the intent while another host is on screen", () => {
    expect(
      canRouteConsumeWorkspaceOpenIntent(
        routeInput({ pathname: buildHostWorkspaceRoute("other-srv", WORKSPACE_B) }),
      ),
    ).toBe(false);
  });

  it("keeps a route from consuming the intent while a non-workspace route is on screen", () => {
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({ pathname: "/h/srv/sessions" }))).toBe(
      false,
    );
  });

  it("trusts the route's own params during cold mount before the pathname settles", () => {
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({ pathname: "/" }))).toBe(true);
    expect(canRouteConsumeWorkspaceOpenIntent(routeInput({ pathname: "" }))).toBe(true);
  });

  it("matches path-shaped workspace ids through their encoded segment", () => {
    expect(
      canRouteConsumeWorkspaceOpenIntent(
        routeInput({
          workspaceId: "/tmp/repo",
          pathname: buildHostWorkspaceRoute("srv", "/tmp/repo"),
        }),
      ),
    ).toBe(true);
  });
});
