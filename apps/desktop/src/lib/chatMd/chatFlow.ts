/**
 * Chat-in-a-note actions (port of chatgpt-md): send the open note to the
 * model and stream the reply into it, start a new chat note, pick the
 * model, infer a title, clear the messages. wiki: ipc-api (`ai_chat_*`).
 */
import { listen } from "@tauri-apps/api/event";

import {
  AI_CHAT_CHUNK_EVENT,
  aiChatSend,
  aiChatStop,
  aiInferTitle,
  type AiChatChunk,
} from "../api/ai";
import { notesCreate, notesRead, notesWrite } from "../api/notes";
import { appConfigSetAi } from "../api/settings";
import {
  getFrontMatterField,
  replaceBody,
  setFrontMatterField,
} from "../frontMatter";
import { openDocument } from "../openDocument";
import {
  DEFAULT_AI_SETTINGS,
  formatAppError,
  isAppError,
  type AiSettings,
} from "../types";
import { useAuthStore } from "../../state/authStore";
import {
  appendToDocument,
  keyFor,
  placeCursorAtEnd,
  readCurrentDoc,
  removeDocumentSuffix,
  replaceWholeDocument,
  useEditorStore,
} from "../../state/editorStore";
import { useSettingsStore } from "../../state/settingsStore";
import { useUIStore } from "../../state/uiStore";
import { notifyVaultContentChanged } from "../../state/vaultContentStore";
import { useVaultStore } from "../../state/vaultStore";
import { chatHeader, chatTitle } from "./format";

export const NO_NOTE_MESSAGE = "Open a note to chat.";

/** Current chat settings (defaults until the config has loaded). */
export function chatSettings(): AiSettings {
  const ai = useSettingsStore.getState().config?.ai;
  if (ai === undefined) return DEFAULT_AI_SETTINGS;
  return {
    defaultModel: ai.defaultModel,
    temperature: ai.temperature,
    maxTokens: ai.maxTokens,
    stream: ai.stream,
    headingLevel: ai.headingLevel,
    inferTitleLanguage: ai.inferTitleLanguage,
    chatsFolder: ai.chatsFolder,
    agentsFolder: ai.agentsFolder,
  };
}

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c !== undefined && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fail(docKey: string, message: string) {
  const ui = useUIStore.getState();
  ui.setNotice(`Chat failed: ${message}`);
  ui.setChatError({ docKey, message });
}

/**
 * Send the open note (live text) and append the reply: an assistant
 * header, the streamed deltas, then a `role::user` header for the next
 * message. Writes only into the note it started on — switching notes
 * stops the request.
 */
export async function sendChat(): Promise<void> {
  const ui = useUIStore.getState();
  const open = useEditorStore.getState().open;
  if (open === null) {
    ui.setNotice(NO_NOTE_MESSAGE);
    return;
  }
  if (ui.chatRequest !== null) {
    ui.setNotice("Chat: a reply is already in progress.");
    return;
  }
  const key = open.key;
  const content = readCurrentDoc() ?? open.content;
  const settings = chatSettings();
  const model = getFrontMatterField(content, "model") ?? settings.defaultModel;
  const streamField = getFrontMatterField(content, "stream");
  const stream =
    streamField === null ? settings.stream : /^true$/i.test(streamField);
  const header = chatHeader("assistant", settings.headingLevel, model);
  const requestId = newRequestId();

  ui.setChatError(null);
  ui.setChatRequest({ requestId, docKey: key, model });

  let aborted = false;
  let received = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    void aiChatStop(requestId).catch(() => {});
  };
  const unsubscribe = useEditorStore.subscribe((s) => {
    if (s.open?.key !== key) abort();
  });
  const unsubscribeAccess = useAuthStore.subscribe((state, previous) => {
    if (state.busy === "lock" || (previous.session !== null && state.session === null)) abort();
  });
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const unsubscribeVault = useVaultStore.subscribe((state) => {
    if ((state.active?.root ?? null) !== vaultRoot) abort();
  });
  let unlisten: (() => void) | null = null;

  try {
    appendToDocument(key, header);
    if (stream) {
      try {
        unlisten = await listen<AiChatChunk>(AI_CHAT_CHUNK_EVENT, (e) => {
          if (aborted || e.payload.requestId !== requestId) return;
          if (e.payload.delta === "") return;
          if (appendToDocument(key, e.payload.delta)) received = true;
          else abort();
        });
      } catch {
        // No event channel (plain browser): the full text still arrives.
      }
    }
    if (aborted) return;
    const reply = await aiChatSend(requestId, open.source.relPath, content);
    if (aborted) return;
    if (!received) appendToDocument(key, reply.text);
    appendToDocument(key, chatHeader("user", settings.headingLevel));
    placeCursorAtEnd(key);
  } catch (e) {
    if (aborted) return;
    if (isAppError(e) && e.kind === "Cancelled") {
      if (received) {
        appendToDocument(key, chatHeader("user", settings.headingLevel));
        placeCursorAtEnd(key);
      } else {
        removeDocumentSuffix(key, header);
      }
      useUIStore.getState().setNotice("Chat stopped.");
      return;
    }
    if (!received) removeDocumentSuffix(key, header);
    fail(key, formatAppError(e));
  } finally {
    unlisten?.();
    unsubscribe();
    unsubscribeAccess();
    unsubscribeVault();
    const current = useUIStore.getState();
    if (current.chatRequest?.requestId === requestId) {
      current.setChatRequest(null);
    }
  }
}

/** Stop the in-flight chat request, if any. */
export function stopChat(): void {
  const request = useUIStore.getState().chatRequest;
  if (request === null) return;
  void aiChatStop(request.requestId).catch(() => {});
}

/**
 * Create `Chat <date time>` in the chats folder with the default model
 * settings in its front matter and open it for typing.
 */
export async function newChat(now: Date = new Date()): Promise<void> {
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const settings = chatSettings();
  try {
    const meta = await notesCreate(settings.chatsFolder, chatTitle(now));
    if ((useVaultStore.getState().active?.root ?? null) !== vaultRoot) return;
    const doc = await notesRead(meta.relPath);
    let content = doc.content;
    content = setFrontMatterField(content, "model", settings.defaultModel);
    content = setFrontMatterField(
      content,
      "temperature",
      String(settings.temperature),
      true,
    );
    content = setFrontMatterField(
      content,
      "max_tokens",
      String(settings.maxTokens),
      true,
    );
    content = setFrontMatterField(
      content,
      "stream",
      String(settings.stream),
      true,
    );
    await notesWrite(meta.relPath, content, doc.version, vaultRoot);
    if ((useVaultStore.getState().active?.root ?? null) !== vaultRoot) return;
    void useAuthStore
      .getState()
      .logAction("note_create", meta.relPath)
      .catch(() => {});
    notifyVaultContentChanged();
    const opened = await openDocument(
      { kind: "note", relPath: meta.relPath },
      { edit: true },
    );
    if (opened) {
      const key = keyFor({ kind: "note", relPath: meta.relPath });
      // The view rebuilds after the open; place the cursor once it has.
      setTimeout(() => placeCursorAtEnd(key), 0);
    }
  } catch (e) {
    useUIStore.getState().setNotice(`New chat failed: ${formatAppError(e)}`);
  }
}

/**
 * Use `model` (`provider@model`): written to the open note's front
 * matter, or — with no note open — saved as the default model.
 */
export async function applyModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (trimmed === "") return;
  const ui = useUIStore.getState();
  const doc = readCurrentDoc();
  if (doc !== null) {
    replaceWholeDocument(setFrontMatterField(doc, "model", trimmed));
    ui.setNotice(`Chat model: ${trimmed}`);
    return;
  }
  try {
    const config = await appConfigSetAi({
      ...chatSettings(),
      defaultModel: trimmed,
    });
    useSettingsStore.getState().setConfig(config);
    ui.setNotice(`Default chat model: ${trimmed}`);
  } catch (e) {
    ui.setNotice(`Couldn't set the model: ${formatAppError(e)}`);
  }
}

/** Ask the model for a title and store it as front matter `title:`. */
export async function inferTitle(): Promise<void> {
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const ui = useUIStore.getState();
  const open = useEditorStore.getState().open;
  const doc = readCurrentDoc();
  if (open === null || doc === null) {
    ui.setNotice(NO_NOTE_MESSAGE);
    return;
  }
  try {
    const title = (await aiInferTitle(doc)).trim();
    if (title === "") return;
    const current = readCurrentDoc();
    if (useEditorStore.getState().open?.key !== open.key || current === null ||
        (useVaultStore.getState().active?.root ?? null) !== vaultRoot) {
      return;
    }
    replaceWholeDocument(setFrontMatterField(current, "title", title));
    useUIStore.getState().setNotice(`Title: ${title}`);
  } catch (e) {
    useUIStore.getState().setNotice(`Infer title failed: ${formatAppError(e)}`);
  }
}

/** Remove every message, keeping the front matter (asks first). */
export function clearChat(): void {
  const doc = readCurrentDoc();
  if (doc === null) {
    useUIStore.getState().setNotice(NO_NOTE_MESSAGE);
    return;
  }
  if (
    !window.confirm("Clear all messages in this chat? The front matter is kept.")
  ) {
    return;
  }
  replaceWholeDocument(replaceBody(doc, ""));
}
