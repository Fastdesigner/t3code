import type { Editor } from "@tiptap/core";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

// ProseMirror selects its iOS Enter fallback when its module is first evaluated.
// A dedicated browser-test iframe keeps this identity out of the desktop tests.
vi.hoisted(() => {
  Object.defineProperties(navigator, {
    platform: { configurable: true, value: "MacIntel" },
    vendor: { configurable: true, value: "Apple Computer, Inc." },
    maxTouchPoints: { configurable: true, value: 5 },
    userAgent: {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Safari/605.1.15",
    },
  });
  Object.defineProperty(document, "ontouchend", { configurable: true, value: null });
});

it.each([false, true])(
  "keeps hardware Shift+Enter out of the iOS unmodified Enter fallback (rich text: %s)",
  async (richTextEnabled) => {
    const submit = vi.fn();
    const commandKey = vi.fn((_key: string, event: KeyboardEvent) => {
      if (event.shiftKey) return false;
      submit();
      return true;
    });
    await using screen = await render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value="line one"
        cursor={8}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
        onCommandKeyDown={commandKey}
      />,
    );
    const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
    if (!element) throw new Error("Composer did not mount");
    const editor = element.editor;
    await act(async () => {
      editor.commands.setTextSelection(9);
      editor.view.focus();
    });
    using _timers = fakeTimers();
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(submit).not.toHaveBeenCalled();
    expect(commandKey).toHaveBeenCalledExactlyOnceWith(
      "Enter",
      expect.objectContaining({ shiftKey: true }),
      false,
    );
    expect(serializeEditorDoc(editor.state.doc).value).toBe("line one\n");

    commandKey.mockClear();
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(commandKey).toHaveBeenCalledExactlyOnceWith(
      "Enter",
      expect.objectContaining({ key: "Enter" }),
      false,
    );
    expect(commandKey.mock.calls[0]?.[1].shiftKey).toBeFalsy();
    expect(serializeEditorDoc(editor.state.doc).value).toBe("line one\n");

    commandKey.mockClear();
    submit.mockClear();
    await act(async () => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(commandKey).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(serializeEditorDoc(editor.state.doc).value).toBe("line one\n");
  },
);
