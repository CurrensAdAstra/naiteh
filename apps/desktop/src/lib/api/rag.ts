import { invoke } from "@tauri-apps/api/core";

import type { LegalDocsStatus } from "../types";

const REPO_URL = "https://github.com/legalize-kr/legalize-kr.git";

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return true;
  const maybeWindow = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

function browserPreviewStatus(): LegalDocsStatus {
  return {
    repoUrl: REPO_URL,
    localPath: "Desktop runtime required",
    docsPath: "Desktop runtime required",
    installed: false,
    branch: null,
    head: null,
    documentCount: 0,
  };
}

export function legalDocsStatus(): Promise<LegalDocsStatus> {
  if (!hasTauriRuntime()) return Promise.resolve(browserPreviewStatus());
  return invoke<LegalDocsStatus>("legal_docs_status");
}

export function legalDocsSync(): Promise<LegalDocsStatus> {
  if (!hasTauriRuntime()) {
    return Promise.reject({
      kind: "NotFound",
      message: "Desktop runtime is required to sync legal documents.",
    });
  }
  return invoke<LegalDocsStatus>("legal_docs_sync");
}
