/**
 * Editor – wraps Monaco Editor with:
 *  - Remote cursor decorations
 *  - Local cursor tracking
 *  - Line-level authorship blame shown via a custom overlay positioned next to each line
 *  - Language-aware syntax highlighting + theme switching
 */
import { useRef, useEffect, useCallback, useState } from "react";
import MonacoEditor from "@monaco-editor/react";

export default function Editor({
  code,
  originalCode,
  language,
  isDark,
  users,
  remoteCursors,
  lineAuthors,
  currentUserId,
  currentUser,
  onChange,
  onCursorChange,
  onLinesEdited,
}) {
  const editorRef        = useRef(null);
  const monacoRef        = useRef(null);
  const blameDecoRef     = useRef([]);   // array of decoration IDs
  const cursorDecoRef    = useRef({});   // userId → decoration IDs
  const diffDecoRef      = useRef([]);   // git diff decoration IDs
  const [diffStats, setDiffStats] = useState(null);
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

  // ── GitHub Line Diff decorations ──────────────────────────────────────────
  const updateDiff = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;

    if (originalCode == null) {
      diffDecoRef.current = editor.deltaDecorations(diffDecoRef.current, []);
      setDiffStats(null);
      return;
    }

    const diffs = computeLineDiff(originalCode, code);
    const totalLines = model.getLineCount();

    let addedCount = 0;
    let modifiedCount = 0;
    let deletedCount = 0;

    const newDecos = diffs
      .filter((d) => d.line >= 1 && d.line <= totalLines)
      .map(({ line, type }) => {
        if (type === "added") addedCount++;
        else if (type === "modified") modifiedCount++;
        else if (type === "deleted") deletedCount++;

        const gutterClass =
          type === "added"
            ? "git-gutter-added"
            : type === "modified"
            ? "git-gutter-modified"
            : "git-gutter-deleted";

        const lineBgClass =
          type === "added"
            ? "git-line-added-bg"
            : type === "modified"
            ? "git-line-modified-bg"
            : "git-line-deleted-bg";

        const hoverText =
          type === "added"
            ? "**GitHub Diff**: Added line"
            : type === "modified"
            ? "**GitHub Diff**: Modified line (changed from GitHub)"
            : "**GitHub Diff**: Line(s) deleted before this line";

        return {
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: gutterClass,
            className: lineBgClass,
            hoverMessage: { value: hoverText },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      });

    diffDecoRef.current = editor.deltaDecorations(diffDecoRef.current, newDecos);
    setDiffStats({
      added: addedCount,
      modified: modifiedCount,
      deleted: deletedCount,
      total: addedCount + modifiedCount + deletedCount,
    });
  }, [code, originalCode]);

  useEffect(() => {
    updateDiff();
  }, [updateDiff]);

  // Distinct author colors currently present in the room — the signature stripe
  const gutterColors = [...new Set(users.map((u) => u.color))];

  return (
    <div className="flex-1 min-h-0 relative flex">
      {/* GitHub line diff badge indicator */}
      {originalCode != null && (
        <div className="absolute top-2.5 right-6 z-20 pointer-events-none select-none flex items-center gap-1.5 px-2.5 py-1 rounded bg-panel/90 backdrop-blur border border-line text-[11px] font-mono shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-signal shrink-0" />
          <span className="text-paper-faint">GitHub:</span>
          {diffStats && diffStats.total > 0 ? (
            <>
              {diffStats.added > 0 && (
                <span className="text-emerald-400 font-semibold">+{diffStats.added}</span>
              )}
              {diffStats.modified > 0 && (
                <span className="text-sky-400 font-semibold">~{diffStats.modified}</span>
              )}
              {diffStats.deleted > 0 && (
                <span className="text-rose-400 font-semibold">-{diffStats.deleted}</span>
              )}
              <span className="text-paper-faint text-[10px]">changed</span>
            </>
          ) : (
            <span className="text-paper-muted text-[10px]">clean (in sync)</span>
          )}
        </div>
      )}

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

/**
 * Compute line differences between originalCode (from GitHub) and current code.
 * Returns array of { line: number, type: 'added' | 'modified' | 'deleted' }
 */
function computeLineDiff(originalText, currentText) {
  if (originalText == null) return [];
  if (originalText === currentText) return [];

  const orig = originalText.split("\n");
  const curr = currentText.split("\n");
  const m = orig.length;
  const n = curr.length;

  if (m * n > 2500000) {
    const res = [];
    for (let i = 0; i < n; i++) {
      if (i >= m) res.push({ line: i + 1, type: "added" });
      else if (orig[i] !== curr[i]) res.push({ line: i + 1, type: "modified" });
    }
    return res;
  }

  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (orig[i - 1] === curr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = m;
  let j = n;
  const diffMap = new Map();

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && orig[i - 1] === curr[j - 1]) {
      i--;
      j--;
    } else {
      const hunkAdds = [];
      const hunkDels = [];
      while ((i > 0 || j > 0) && !(i > 0 && j > 0 && orig[i - 1] === curr[j - 1])) {
        if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
          hunkAdds.push(j);
          j--;
        } else {
          hunkDels.push(i);
          i--;
        }
      }
      if (hunkAdds.length > 0 && hunkDels.length > 0) {
        hunkAdds.forEach((line) => diffMap.set(line, "modified"));
      } else if (hunkAdds.length > 0) {
        hunkAdds.forEach((line) => diffMap.set(line, "added"));
      } else if (hunkDels.length > 0) {
        const anchor = Math.max(1, Math.min(n, j + 1));
        if (!diffMap.has(anchor)) {
          diffMap.set(anchor, "deleted");
        }
      }
    }
  }

  return [...diffMap.entries()]
    .map(([line, type]) => ({ line, type }))
    .sort((a, b) => a.line - b.line);
}
