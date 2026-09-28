import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

interface WorkspaceOpenIntentRoute {
  openValue: string;
  isRouteFocused: boolean;
  pathname: string;
  serverId: string;
  workspaceId: string;
}

// Hidden workspace routes stay mounted in the host stack. Only the focused route
// whose workspace is on screen may consume an open intent; any other instance
// would pin the target agent into its own workspace's tabs.
export function canRouteConsumeWorkspaceOpenIntent(route: WorkspaceOpenIntentRoute): boolean {
  if (!route.openValue || !route.isRouteFocused) {
    return false;
  }
  // During cold mount the pathname is still "/" or empty and the route's own
  // params are the only selection (docs/expo-router.md).
  if (route.pathname === "/" || route.pathname === "") {
    return true;
  }
  const onScreen = parseHostWorkspaceRouteFromPathname(route.pathname);
  return onScreen?.serverId === route.serverId && onScreen.workspaceId === route.workspaceId;
}
