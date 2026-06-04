import { invoke } from "@tauri-apps/api/core";

export function aiImprove(text: string, instruction: string): Promise<string> {
  return invoke<string>("ai_improve", { text, instruction });
}

/**
 * List models available at the configured endpoint
 * (`GET {baseUrl}/models`). For Ollama this returns the locally-pulled
 * models. Lets Settings offer a picker instead of free-text.
 */
export function aiListModels(): Promise<string[]> {
  return invoke<string[]>("ai_list_models");
}
