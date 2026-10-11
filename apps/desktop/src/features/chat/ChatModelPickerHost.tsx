import { applyModel, chatSettings } from "../../lib/chatMd/chatFlow";
import { getFrontMatterField } from "../../lib/frontMatter";
import { readCurrentDoc } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { ModelPicker } from "./ModelPicker";

/**
 * "Chat: Select model" — writes `model:` into the open note's front
 * matter, or sets the default model when no note is open.
 */
export function ChatModelPickerHost() {
  const open = useUIStore((s) => s.modelPickerOpen);
  const setOpen = useUIStore((s) => s.setModelPickerOpen);
  if (!open) return null;
  const doc = readCurrentDoc();
  const initial =
    (doc === null ? null : getFrontMatterField(doc, "model")) ??
    chatSettings().defaultModel;
  return (
    <ModelPicker
      title={doc === null ? "Select default chat model" : "Select chat model"}
      initial={initial}
      onPick={(model) => void applyModel(model)}
      onClose={() => setOpen(false)}
    />
  );
}
