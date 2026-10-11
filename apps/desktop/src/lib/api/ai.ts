import { invoke } from "./invoke";

/** Reply to a chat note (wiki: ipc-api, `ai_chat_send`). */
export interface AiChatReply {
  /** `provider@model` that answered. */
  model: string;
  /** The whole reply (also streamed as `ai:chat-chunk` deltas when streaming). */
  text: string;
}

/** Payload of the `ai:chat-chunk` event. */
export interface AiChatChunk {
  requestId: string;
  delta: string;
}

export const AI_CHAT_CHUNK_EVENT = "ai:chat-chunk";

/**
 * Send the chat note at `docRelPath` (its live `content`) to the model
 * named in its front matter (or the default). Streaming deltas arrive as
 * `ai:chat-chunk` events tagged with `requestId` before this resolves.
 */
export function aiChatSend(
  requestId: string,
  docRelPath: string,
  content: string,
): Promise<AiChatReply> {
  return invoke<AiChatReply>("ai_chat_send", { requestId, docRelPath, content });
}

/** Cancel an in-flight `ai_chat_send` (it rejects with `Cancelled`). */
export function aiChatStop(requestId: string): Promise<void> {
  return invoke<void>("ai_chat_stop", { requestId });
}

/** Ask the default model for a short title for the chat `content`. */
export function aiInferTitle(content: string): Promise<string> {
  return invoke<string>("ai_infer_title", { content });
}

/** Model ids (`provider@model`) the provider offers. */
export function aiListModels(provider: string): Promise<string[]> {
  return invoke<string[]>("ai_list_models", { provider });
}
