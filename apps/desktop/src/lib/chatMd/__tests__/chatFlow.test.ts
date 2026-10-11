import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChunkHandler = (e: { payload: { requestId: string; delta: string } }) => void;
let chunkHandler: ChunkHandler | null = null;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, handler: ChunkHandler) => {
    chunkHandler = handler;
    return Promise.resolve(unlisten);
  }),
}));
vi.mock("../../api/ai", () => ({
  AI_CHAT_CHUNK_EVENT: "ai:chat-chunk",
  aiChatSend: vi.fn(),
  aiChatStop: vi.fn(() => Promise.resolve()),
  aiInferTitle: vi.fn(),
}));
vi.mock("../../api/notes", () => ({
  notesCreate: vi.fn(),
  notesRead: vi.fn(),
  notesWrite: vi.fn(),
}));
vi.mock("../../api/settings", () => ({ appConfigSetAi: vi.fn() }));
vi.mock("../../openDocument", () => ({ openDocument: vi.fn() }));
vi.mock("../../../state/authStore", () => ({
  useAuthStore: {
    getState: () => ({ logAction: () => Promise.resolve() }),
  },
}));

import { listen } from "@tauri-apps/api/event";

import { aiChatSend, aiChatStop, aiInferTitle, type AiChatReply } from "../../api/ai";
import { notesCreate, notesRead, notesWrite } from "../../api/notes";
import { appConfigSetAi } from "../../api/settings";
import { openDocument } from "../../openDocument";
import { defaultAiConfig, DEFAULT_AI_SETTINGS, type AppConfig } from "../../types";
import { useEditorStore } from "../../../state/editorStore";
import { useSettingsStore } from "../../../state/settingsStore";
import { useUIStore } from "../../../state/uiStore";
import {
  applyModel,
  clearChat,
  inferTitle,
  newChat,
  sendChat,
  stopChat,
} from "../chatFlow";
import { chatHeader } from "../format";

const mockedSend = vi.mocked(aiChatSend);
const mockedStop = vi.mocked(aiChatStop);

const NOTE = "---\nmodel: openai@gpt-x\n---\nHello";
const ASSISTANT = chatHeader("assistant", 3, "openai@gpt-x");
const USER = chatHeader("user", 3);

function content(): string {
  return useEditorStore.getState().open?.content ?? "";
}

function emit(requestId: string, delta: string) {
  if (chunkHandler === null) throw new Error("no chunk listener");
  chunkHandler({ payload: { requestId, delta } });
}

/** A send whose resolution the test controls. */
function pendingSend() {
  let resolve: (r: AiChatReply) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  mockedSend.mockImplementation(
    () =>
      new Promise<AiChatReply>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    resolve: (r: AiChatReply) => resolve(r),
    reject: (e: unknown) => reject(e),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function config(): AppConfig {
  return {
    activeVault: "/v",
    knownVaults: ["/v"],
    theme: "light",
    editor: { fontSize: 14, lineWrapping: true },
    calendar: { subView: "timeline" },
    journal: { splitRatio: 0.5 },
    ai: defaultAiConfig(),
    appearance: { palette: "default", uiFont: "", editorFont: "" },
  } as unknown as AppConfig;
}

describe("chat flow", () => {
  beforeEach(() => {
    chunkHandler = null;
    vi.clearAllMocks();
    useEditorStore.setState({ open: null, view: null });
    useEditorStore.getState().openNote("notes/chat.md", NOTE, "v1");
    useUIStore.setState({
      chatRequest: null,
      chatError: null,
      notice: null,
      editorMode: "view",
    });
    useSettingsStore.setState({ config: config() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams chunks in order, then appends the user header", async () => {
    const send = pendingSend();
    const done = sendChat();
    await flush();
    const request = useUIStore.getState().chatRequest;
    expect(request?.model).toBe("openai@gpt-x");
    expect(content()).toBe(NOTE + ASSISTANT);
    expect(mockedSend).toHaveBeenCalledWith(request?.requestId, "notes/chat.md", NOTE);

    emit(request?.requestId ?? "", "Hel");
    emit("someone-else", "XX");
    emit(request?.requestId ?? "", "lo!");
    expect(content()).toBe(`${NOTE}${ASSISTANT}Hello!`);

    send.resolve({ model: "openai@gpt-x", text: "Hello!" });
    await done;
    expect(content()).toBe(`${NOTE}${ASSISTANT}Hello!${USER}`);
    expect(useUIStore.getState().chatRequest).toBeNull();
    expect(unlisten).toHaveBeenCalled();
  });

  it("stops and never writes into another note opened mid-stream", async () => {
    const send = pendingSend();
    const done = sendChat();
    await flush();
    const id = useUIStore.getState().chatRequest?.requestId ?? "";
    emit(id, "part");
    useEditorStore.getState().openNote("notes/other.md", "Other", "v2");
    expect(mockedStop).toHaveBeenCalledWith(id);
    emit(id, " more");
    send.resolve({ model: "openai@gpt-x", text: "part more" });
    await done;
    expect(content()).toBe("Other");
    expect(useUIStore.getState().chatRequest).toBeNull();
  });

  it("on an error with no chunks removes the header and reports it", async () => {
    const send = pendingSend();
    const done = sendChat();
    await flush();
    send.reject({ kind: "Validation", message: "No API key for openai. Add it in Settings → AI." });
    await done;
    expect(content()).toBe(NOTE);
    expect(useUIStore.getState().notice).toMatch(/No API key for openai/);
    expect(useUIStore.getState().chatError).toEqual({
      docKey: "note:notes/chat.md",
      message: expect.stringContaining("No API key"),
    });
  });

  it("non-stream mode inserts the whole reply at once", async () => {
    useEditorStore
      .getState()
      .openNote("notes/chat.md", "---\nstream: false\n---\nQ", "v1");
    mockedSend.mockResolvedValue({ model: "anthropic@claude", text: "Answer" });
    useSettingsStore.setState({
      config: { ...config(), ai: { ...defaultAiConfig(), defaultModel: "anthropic@claude" } },
    });
    await sendChat();
    expect(listen).not.toHaveBeenCalled();
    expect(content()).toBe(
      `---\nstream: false\n---\nQ${chatHeader("assistant", 3, "anthropic@claude")}Answer${USER}`,
    );
  });

  it("refuses without an open note and allows one request at a time", async () => {
    useEditorStore.setState({ open: null });
    await sendChat();
    expect(useUIStore.getState().notice).toBe("Open a note to chat.");
    expect(mockedSend).not.toHaveBeenCalled();

    useEditorStore.getState().openNote("notes/chat.md", NOTE, "v1");
    useUIStore.setState({
      chatRequest: { requestId: "busy", docKey: "note:notes/chat.md", model: "m" },
    });
    await sendChat();
    expect(mockedSend).not.toHaveBeenCalled();
    stopChat();
    expect(mockedStop).toHaveBeenCalledWith("busy");
  });

  it("a stop with no chunks removes the header quietly", async () => {
    const send = pendingSend();
    const done = sendChat();
    await flush();
    send.reject({ kind: "Cancelled", message: "stopped" });
    await done;
    expect(content()).toBe(NOTE);
    expect(useUIStore.getState().chatError).toBeNull();
    expect(useUIStore.getState().notice).toBe("Chat stopped.");
  });

  it("new chat creates the note with default front matter and opens it", async () => {
    vi.mocked(notesCreate).mockResolvedValue({
      relPath: "notes/chats/chat-2026-10-11-0930.md",
    } as never);
    vi.mocked(notesRead).mockResolvedValue({
      content: '---\ntitle: "Chat 2026-10-11 0930"\n---\n\n',
      version: "v0",
    });
    vi.mocked(notesWrite).mockResolvedValue({} as never);
    vi.mocked(openDocument).mockResolvedValue(true);
    await newChat(new Date(2026, 9, 11, 9, 30));
    expect(notesCreate).toHaveBeenCalledWith("notes/chats", "Chat 2026-10-11 0930");
    expect(notesWrite).toHaveBeenCalledWith(
      "notes/chats/chat-2026-10-11-0930.md",
      `---\ntitle: "Chat 2026-10-11 0930"\nmodel: ${DEFAULT_AI_SETTINGS.defaultModel}\ntemperature: 1\nmax_tokens: 400\nstream: true\n---\n\n`,
      "v0",
    );
    expect(openDocument).toHaveBeenCalledWith(
      { kind: "note", relPath: "notes/chats/chat-2026-10-11-0930.md" },
      { edit: true },
    );
  });

  it("select model writes the note's front matter", async () => {
    await applyModel("ollama@llama3.2");
    expect(content()).toBe("---\nmodel: ollama@llama3.2\n---\nHello");
    expect(appConfigSetAi).not.toHaveBeenCalled();
  });

  it("select model without an open note sets the default model", async () => {
    useEditorStore.setState({ open: null });
    vi.mocked(appConfigSetAi).mockResolvedValue(config());
    await applyModel("gemini@gemini-2.5-flash");
    expect(appConfigSetAi).toHaveBeenCalledWith({
      ...DEFAULT_AI_SETTINGS,
      defaultModel: "gemini@gemini-2.5-flash",
    });
  });

  it("infer title stores the title in front matter", async () => {
    vi.mocked(aiInferTitle).mockResolvedValue("  Greetings: a chat ");
    await inferTitle();
    expect(aiInferTitle).toHaveBeenCalledWith(NOTE);
    expect(content()).toBe(
      '---\nmodel: openai@gpt-x\ntitle: "Greetings: a chat"\n---\nHello',
    );
  });

  it("clear chat keeps the front matter after confirming", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    clearChat();
    expect(content()).toBe(NOTE);
    confirm.mockReturnValueOnce(true);
    clearChat();
    expect(content()).toBe("---\nmodel: openai@gpt-x\n---\n");
  });
});
