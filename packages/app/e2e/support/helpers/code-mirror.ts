import { expect, type Locator } from "@playwright/test";

interface CodeMirrorInput {
  editor: Locator;
  content: string;
}

/** Replace the document through CodeMirror's keyboard selection, then insert one complete edit.
 * Selecting the contenteditable DOM directly can leave the editor's document selection behind.
 * One input preserves multiline text without starting autosave between individual keystrokes.
 */
export async function replaceCodeMirrorContent({
  editor,
  content,
}: CodeMirrorInput): Promise<void> {
  await expect(editor).toBeVisible();
  await editor.focus();
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+A");
  await editor.page().keyboard.insertText(content);
}
