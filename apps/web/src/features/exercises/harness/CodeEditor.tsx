import { useRef, useState, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react';

/**
 * A code editor that is a `<textarea>`.
 *
 * `docs/01-architecture.md` lists CodeMirror 6 in the stack for exactly this exercise,
 * and CodeMirror is **not installed** — adding a dependency needs the learner's
 * agreement (`CLAUDE.md`), so M11 ships a textarea and
 * `docs/adr/0003-harness-worker-deviations.md` records the swap. What is lost is syntax
 * highlighting, bracket matching and multi-cursor. What is kept is everything the
 * exercise actually depends on: a monospace grid, a tab key that indents instead of
 * moving focus, and line numbers to read a stack trace against.
 *
 * The gutter is a second element scrolled in lockstep rather than a background image or
 * a `::before`, because those two go out of alignment the moment a line wraps — and a
 * long `messages.push({...})` wraps constantly. `white-space: pre` with horizontal
 * scrolling instead of wrapping is what keeps the two columns in step, and it is also
 * how every real editor behaves.
 */

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  rows?: number;
  /** Test hook and a11y anchor. */
  id?: string;
}

const TAB = '  ';

export function CodeEditor({
  value,
  onChange,
  disabled = false,
  label,
  rows = 22,
  id = 'harness-code',
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(() => value.split('\n').length);

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setLineCount(event.target.value.split('\n').length);
    onChange(event.target.value);
  }

  /**
   * Tab indents, Shift+Tab outdents, and both keep the selection where the eye expects.
   *
   * Swallowing Tab in a textarea is normally an accessibility sin — it is how keyboard
   * users leave the field. Escape-then-Tab is the escape hatch every code editor on the
   * web uses, and the hint under the editor says so, because an undocumented one is the
   * same as none.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const area = event.currentTarget;
    if (event.key === 'Escape') {
      // Leaves the trap: the next Tab moves focus normally.
      area.blur();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();

    const { selectionStart, selectionEnd } = area;
    const before = value.slice(0, selectionStart);
    const after = value.slice(selectionEnd);

    if (!event.shiftKey && selectionStart === selectionEnd) {
      const next = `${before}${TAB}${after}`;
      onChange(next);
      setLineCount(next.split('\n').length);
      requestAnimationFrame(() => {
        area.selectionStart = area.selectionEnd = selectionStart + TAB.length;
      });
      return;
    }

    // A selection (or Shift+Tab): shift every touched line by one indent.
    const lineStart = before.lastIndexOf('\n') + 1;
    const block = value.slice(lineStart, selectionEnd);
    const shifted = event.shiftKey
      ? block.replace(new RegExp(`^${TAB}`, 'gm'), '')
      : block.replace(/^/gm, TAB);
    const next = value.slice(0, lineStart) + shifted + after;
    onChange(next);
    setLineCount(next.split('\n').length);
    requestAnimationFrame(() => {
      area.selectionStart = lineStart;
      area.selectionEnd = lineStart + shifted.length;
    });
  }

  function handleScroll(event: UIEvent<HTMLTextAreaElement>): void {
    if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
  }

  return (
    <div>
      <div className="border-rule bg-sunk flex overflow-hidden rounded-md border">
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="text-muted max-h-[32rem] shrink-0 overflow-hidden px-2 py-2 text-right font-mono text-xs leading-5 select-none"
          data-testid="code-gutter"
        >
          {Array.from({ length: lineCount }, (_unused, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          id={id}
          aria-label={label}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={rows}
          disabled={disabled}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          className="bg-surface max-h-[32rem] min-h-72 w-full resize-y overflow-auto border-0 p-2 font-mono text-xs leading-5 whitespace-pre focus:outline-none"
          data-testid="code-editor"
        />
      </div>
      <p className="text-muted mt-1 text-xs leading-5">
        Tab indents, Shift+Tab outdents, <kbd>Esc</kbd> then Tab leaves the editor. Plain
        JavaScript, no imports — <code>runAgent</code> is the only thing that has to exist.
      </p>
    </div>
  );
}
