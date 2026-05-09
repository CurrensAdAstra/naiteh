import { invoke } from "@tauri-apps/api/core";

export function aiImprove(text: string, instruction: string): Promise<string> {
  return invoke<string>("ai_improve", { text, instruction });
}
