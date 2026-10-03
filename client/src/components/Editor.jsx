/**
 * Editor – wraps Monaco Editor with:
 *  - Remote cursor decorations
 *  - Local cursor tracking
 *  - Line-level authorship blame shown via a custom overlay positioned next to each line
 *  - Language-aware syntax highlighting + theme switching
 */
import { useRef, useEffect, useCallback } from "react";
import MonacoEditor from "@monaco-editor/react";

export default function Editor({
  code,
  language,
  isDark,
  users,
  remoteCursors,
  lineAuthors,
  currentUserId,
  onChange,
  onCursorChange,
  onLinesEdited,
}) {
  const editorRef        = useRef(null);
  const monacoRef        = useRef(null);
  const blameDecoRef     = useRef([]);   // array of decoration IDs
  const cursorDecoRef    = useRef({});   // userId → decoration IDs
  const localChangeFlagRef = useRef(false); // true when current code change is local

  // ── Mount ──────────────────────────────────────────────────────────────────
  const handleMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.onDidChangeCursorPosition((e) =>
      onCursorChange({ lineNumber: e.position.lineNumber, column: e.position.column })
    );

    // Track which lines the LOCAL user edits.
    // @monaco-editor/react's onChange fires for user edits only (not programmatic).
    // We set localChangeFlagRef BEFORE onChange in handleChange, so by the time
    // onDidChangeModelContent fires, the flag is already true for local edits.
    editor.onDidChangeModelContent((e) => {
      if (!localChangeFlagRef.current) return;
      localChangeFlagRef.current = false;

      const lines = new Set();
      e.changes.forEach(({ range, text }) => {
        for (let l = range.startLineNumber; l <= range.endLineNumber; l++) lines.add(l);
        if (text) {
          const n = (text.match(/\n/g) || []).length;
          for (let i = 1; i <= n; i++) lines.add(range.startLineNumber + i);
        }
      });
      if (lines.size) onLinesEdited([...lines]);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {});
  };

  /** Only called for user-initiated edits — set flag before onChange propagates. */
  const handleChange = (val) => {
    localChangeFlagRef.current = true;
    onChange(val ?? "");
  };

  // ── Blame labels via `afterContentClassName` + CSS counter trick ───────────
  // We use `options.afterContentClassName` which is a stable Monaco API.
  // The CSS `content` is set via a generated CSS class that includes the label text.
  const updateBlame = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;

    const totalLines = model.getLineCount();
    const newDecos = [];

    Object.entries(lineAuthors).forEach(([lineStr, { name, color, userId }]) => {
      const line = parseInt(lineStr, 10);
      if (line < 1 || line > totalLines) return;

      const label   = userId === currentUserId ? "you" : name;
      const cssKey  = `blame-${sanitise(userId || label)}-${line}`;

      ensureBlameStyle(cssKey, color, label);

      // A zero-width range anchored to this exact line so each author tag stays with its line.
      const endCol = model.getLineMaxColumn(line);
      newDecos.push({
        range: new monaco.Range(line, endCol, line, endCol),
        options: {
          // afterContentClassName adds a ::after pseudo-element after line content.
          // It must be unique per line/user so two tags never share the same CSS output.
          afterContentClassName: cssKey,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    });

    blameDecoRef.current = editor.deltaDecorations(blameDecoRef.current, newDecos);
  }, [lineAuthors, currentUserId]);

  useEffect(() => { updateBlame(); }, [updateBlame]);

  // ── Remote cursor decorations ──────────────────────────────────────────────
  const updateCursors = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const activeUserIds = new Set(Object.keys(remoteCursors));

    Object.keys(cursorDecoRef.current).forEach((uid) => {
      if (!activeUserIds.has(uid)) {
        const previousIds = cursorDecoRef.current[uid] || [];
        if (previousIds.length) {
          editor.deltaDecorations(previousIds, []);
        }
        delete cursorDecoRef.current[uid];
      }
    });

    Object.entries(remoteCursors).forEach(([userId, cursor]) => {
      if (!cursor || userId === currentUserId) return;
      const user = users.find((u) => u.id === userId);
      if (!user) return;

      const scopeKey = `cursor-${sanitise(userId)}`;
      ensureCursorStyle(scopeKey, user.color);

      const previousIds = cursorDecoRef.current[userId] || [];
      cursorDecoRef.current[userId] = editor.deltaDecorations(previousIds, [{
        range: new monaco.Range(
          cursor.lineNumber, cursor.column,
          cursor.lineNumber, cursor.column
        ),
        options: {
          className: `remote-cursor-${scopeKey}`,
          afterContentClassName: `remote-cursor-label-${scopeKey}`,
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }]);
    });
  }, [remoteCursors, users, currentUserId]);

  useEffect(() => { updateCursors(); }, [updateCursors]);

  // Distinct author colors currently present in the room — the signature stripe
  const gutterColors = [...new Set(users.map((u) => u.color))];

  return (
    <div className="flex-1 min-h-0 relative flex">
      {/* Author gutter — a live stripe of everyone present, the app's signature */}
      <div className="author-gutter">
        {(gutterColors.length ? gutterColors : ["#242B34"]).map((c, i) => (
          <span key={i} style={{ backgroundColor: c }} />
        ))}
      </div>
      <MonacoEditor
        height="100%"
        language={language}
        value={code}
        theme={isDark ? "vs-dark" : "light"}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontSize: 14,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontLigatures: true,
          lineHeight: 22,
          minimap: { enabled: true, scale: 0.75 },
          scrollbar: { vertical: "auto", horizontal: "auto" },
          wordWrap: "on",
          padding: { top: 16, bottom: 16 },
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          renderLineHighlight: "gutter",
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true },
          formatOnPaste: true,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
        }}
      />
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sanitise(str) {
  return String(str).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const _blameStyles = new Map(); // cssKey → true
/**
 * Inject a <style> that uses afterContentClassName's ::after pseudo-element.
 * The `content` property embeds the blame label text as a string literal.
 */
function ensureBlameStyle(cssKey, color, label) {
  if (_blameStyles.has(cssKey)) return;
  _blameStyles.set(cssKey, true);

  const s = document.createElement("style");
  // Escape single quotes in the label text
  const safeLabel = label.replace(/'/g, "\\'");
  s.textContent = `
    .${cssKey}::after {
      content: '  \\2190 ${safeLabel}';
      color: ${color};
      opacity: 0.45;
      font-size: 11px;
      font-style: italic;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 400;
      pointer-events: none;
      user-select: none;
    }
  `;
  document.head.appendChild(s);
}

const _cursorStyles = new Set();
function ensureCursorStyle(scopeKey, color) {
  if (_cursorStyles.has(scopeKey)) return;
  _cursorStyles.add(scopeKey);

  const s = document.createElement("style");
  s.textContent = `
    .remote-cursor-${scopeKey} {
      border-left: 2px solid ${color} !important;
      background: ${color}33;
    }
    .remote-cursor-label-${scopeKey}::after {
      background: ${color};
      color: #10141A;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 0 2px 2px 2px;
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}
