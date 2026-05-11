import { invoke } from "@tauri-apps/api/core";

import type { LastOpened, WorkspaceState } from "../types";

export function workspaceGet(): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("workspace_get");
}

export function workspaceSetLastOpened(
  lastOpened: LastOpened | null,
): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("workspace_set_last_opened", {
    lastOpened,
  });
}
