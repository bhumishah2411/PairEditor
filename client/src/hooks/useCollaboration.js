/**
 * useCollaboration – orchestrates all real-time collaboration state.
 *
 * Handles:
 *  - Joining a room and receiving initial state
 *  - Sending/receiving code changes
 *  - Cursor tracking
 *  - User list management
 *  - Typing indicators
 *  - Chat messages
 *  - Line-level authorship ("who last edited this line")
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { languageForPath, shouldIncludeFile } from "../utils/fileTree";

export function useCollaboration({ socket, roomId, userName }) {
  const [code, setCode]           = useState("// Start coding here...\n");
  const [language, setLanguageSt] = useState("javascript");
  const [users, setUsers]         = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [typingUsers, setTypingUsers]     = useState(new Set());
  const [chatMessages, setChatMessages]   = useState([]);
  /**
   * lineAuthors: { [lineNumber]: { name, color, userId } }
   * Tracks who last touched each line of code in the room.
   */
  const [lineAuthors, setLineAuthors] = useState({});
  /**
   * files: [{ path, language }] — everything uploaded to the room so far.
   * activeFile: path of the file currently loaded into the shared `code` buffer.
   */
  const [files, setFiles]           = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  // ── Whiteboard collaborative state ───────────────────────────────────────
  const [whiteboardElements, setWhiteboardElements] = useState([]);
  const [remoteWhiteboardCursors, setRemoteWhiteboardCursors] = useState({});
  const [remoteLiveStroke, setRemoteLiveStroke] = useState(null);

  // ── Room-wide synchronized view mode ('code' | 'split' | 'whiteboard') ───
  const [viewMode, setViewMode] = useState("code");

  // Prevent looping our own code-change back into the editor
  const isRemoteChange = useRef(false);
  const typingTimer    = useRef(null);
  const hasJoined      = useRef(false);

  // ── Join room once socket + roomId are ready ─────────────────────────────
  useEffect(() => {
    if (!socket || !roomId || hasJoined.current) return;
    hasJoined.current = true;

    socket.emit("join-room", { roomId, userName });

    // Receive full room state on join (includes existing lineAuthors blame map & whiteboard & viewMode)
    socket.on("room-state", ({ code: c, language: l, users: u, lineAuthors: la, files: f, activeFile: af, whiteboard: wb, viewMode: vm }) => {
      isRemoteChange.current = true;
      setCode(c);
      setLanguageSt(l);
      setUsers(u);
      // la is a plain object { lineNumber: { name, color, userId } }
      if (la) setLineAuthors(la);
      if (f) setFiles(f);
      if (af !== undefined) setActiveFile(af);
      if (wb) setWhiteboardElements(wb);
      if (vm) setViewMode(vm);
    });

    // Another user joined
    socket.on("user-joined", (user) => {
      setUsers((prev) => [...prev.filter((u) => u.id !== user.id), user]);
    });

    // User left
    socket.on("user-left", ({ userId }) => {
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      setRemoteCursors((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setRemoteWhiteboardCursors((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setTypingUsers((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    });

    // Authoritative user list update
    socket.on("users-update", (u) => setUsers(u));

    // Remote code edit
    socket.on("code-update", ({ code: c, senderId }) => {
      if (senderId === socket.id) return; // ignore echo
      isRemoteChange.current = true;
      setCode(c);
    });

    // Language change
    socket.on("language-update", ({ language: l }) => setLanguageSt(l));

    // Remote cursor position
    socket.on("cursor-update", ({ userId, cursor }) => {
      setRemoteCursors((prev) => ({ ...prev, [userId]: cursor }));
    });

    // Typing indicators
    socket.on("user-typing", ({ userId }) =>
      setTypingUsers((prev) => new Set([...prev, userId]))
    );
    socket.on("user-stopped-typing", ({ userId }) => {
      setTypingUsers((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    });

    // Chat
    socket.on("chat-message", (msg) =>
      setChatMessages((prev) => [...prev, msg])
    );

    // ── Line authorship from a remote peer ──────────────────────────────────
    // lines = [{ line, name, color, userId }, …]
    socket.on("line-author-update", ({ lines }) => {
      setLineAuthors((prev) => {
        const next = { ...prev };
        lines.forEach(({ line, name, color, userId }) => {
          next[line] = { name, color, userId };
        });
        return next;
      });
    });

    // ── Files uploaded to the room (by anyone) ──────────────────────────────
    socket.on("files-update", ({ files: f, activeFile: af }) => {
      setFiles(f);
      setActiveFile(af);
      setIsUploading(false);
    });

    socket.on("rename-file-error", ({ message }) => {
      window.alert(message || "Rename failed.");
    });

    // ── The whole room's shared buffer switched to a different file ────────
    socket.on("active-file-changed", ({ path, code: c, language: l, lineAuthors: la }) => {
      isRemoteChange.current = true;
      setActiveFile(path);
      setCode(c);
      setLanguageSt(l);
      setLineAuthors(la || {});
    });

    // ── Whiteboard collaborative sync ────────────────────────────────────────
    socket.on("whiteboard-update", ({ elements }) => {
      setWhiteboardElements(Array.isArray(elements) ? elements : []);
      setRemoteLiveStroke(null);
    });

    socket.on("whiteboard-draw-step", ({ stroke, userId }) => {
      if (userId === socket.id) return;
      setRemoteLiveStroke({ stroke, userId });
    });

    socket.on("whiteboard-cursor-update", ({ userId, userName, color, cursor }) => {
      if (userId === socket.id) return;
      setRemoteWhiteboardCursors((prev) => ({
        ...prev,
        [userId]: { userName, color, ...cursor },
      }));
    });

    // ── Synchronized View Mode (when anyone opens whiteboard, all peers switch) ──
    socket.on("view-mode-update", ({ viewMode: vm }) => {
      if (vm) {
        setViewMode(vm);
        setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
      }
    });

    return () => {
      socket.off("room-state");
      socket.off("user-joined");
      socket.off("user-left");
      socket.off("users-update");
      socket.off("code-update");
      socket.off("language-update");
      socket.off("cursor-update");
      socket.off("user-typing");
      socket.off("user-stopped-typing");
      socket.off("chat-message");
      socket.off("line-author-update");
      socket.off("files-update");
      socket.off("rename-file-error");
      socket.off("active-file-changed");
      socket.off("whiteboard-update");
      socket.off("whiteboard-draw-step");
      socket.off("whiteboard-cursor-update");
      socket.off("view-mode-update");
    };
  }, [socket, roomId, userName]);

  // ── Emit code change ─────────────────────────────────────────────────────
  const handleCodeChange = useCallback(
    (newCode) => {
      if (isRemoteChange.current) {
        isRemoteChange.current = false;
        return;
      }
      setCode(newCode);
      socket?.emit("code-change", { roomId, code: newCode });

      // Typing indicator debounce
      socket?.emit("typing-start", { roomId });
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        socket?.emit("typing-stop", { roomId });
      }, 1500);
    },
    [socket, roomId]
  );

  // ── Emit language change ─────────────────────────────────────────────────
  const handleLanguageChange = useCallback(
    (lang) => {
      setLanguageSt(lang);
      socket?.emit("language-change", { roomId, language: lang });
    },
    [socket, roomId]
  );

  // ── Emit cursor move ─────────────────────────────────────────────────────
  const handleCursorChange = useCallback(
    (cursor) => {
      socket?.emit("cursor-move", { roomId, cursor });
    },
    [socket, roomId]
  );

  // ── Emit line-author update ───────────────────────────────────────────────
  /**
   * Called by Editor whenever the user edits lines.
   * lines: number[]  – the 1-indexed line numbers that were changed.
   * authorInfo: { name, color, userId }
   */
  const emitLineAuthors = useCallback(
    (lines, authorInfo) => {
      if (!socket || !roomId || !lines.length) return;

      const payload = lines.map((line) => ({ line, ...authorInfo }));

      // Update local state immediately so the author sees their own label
      setLineAuthors((prev) => {
        const next = { ...prev };
        payload.forEach(({ line, name, color, userId }) => {
          next[line] = { name, color, userId };
        });
        return next;
      });

      socket.emit("line-author-update", { roomId, lines: payload });
    },
    [socket, roomId]
  );

  // ── Send chat message ────────────────────────────────────────────────────
  const sendChatMessage = useCallback(
    (message) => {
      socket?.emit("chat-message", { roomId, message });
    },
    [socket, roomId]
  );

  // ── Create a new file in the shared room ─────────────────────────────────
  const createFile = useCallback(
    (fileName) => {
      if (!socket || !roomId) return;
      const name = String(fileName || "").trim() || "untitled.js";
      const normalized = name.startsWith("/") ? name.slice(1) : name;
      const safePath = normalized.includes(".") ? normalized : `${normalized}.js`;

      socket.emit("create-file", {
        roomId,
        path: safePath,
        language: (() => {
          const ext = safePath.split(".").pop()?.toLowerCase();
          if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
          if (ext === "ts" || ext === "tsx") return "typescript";
          if (ext === "py") return "python";
          if (ext === "html") return "html";
          if (ext === "css") return "css";
          if (ext === "json") return "json";
          if (ext === "md") return "markdown";
          return "plaintext";
        })(),
        code: "",
      });
    },
    [socket, roomId]
  );

  const renameFile = useCallback(
    (oldPath, newName) => {
      if (!socket || !roomId) return;
      const trimmed = String(newName || "").trim();
      if (!trimmed) return;
      const normalizedOld = String(oldPath || "").replace(/^\/+/, "");
      const baseDir = normalizedOld.includes("/")
        ? normalizedOld.slice(0, normalizedOld.lastIndexOf("/") + 1)
        : "";
      const newPath = `${baseDir}${String(trimmed).replace(/^\/+/, "")}`;
      if (!newPath || newPath === normalizedOld) return;

      socket.emit("rename-file", { roomId, oldPath: normalizedOld, newPath });
    },
    [socket, roomId]
  );

  const deleteFile = useCallback(
    (path) => {
      if (!socket || !roomId) return;
      socket.emit("delete-file", { roomId, path: String(path || "").replace(/^\/+/, "") });
    },
    [socket, roomId]
  );

  // ── Upload a folder: read every included file, then hand the batch to the server ──
  const uploadFolder = useCallback(
    async (fileList) => {
      if (!socket || !roomId || !fileList?.length) return;
      setIsUploading(true);

      const readable = [...fileList].filter((f) => {
        const relPath = f.webkitRelativePath || f.name;
        return shouldIncludeFile(relPath, f.size);
      });

      const readFile = (f) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              path: f.webkitRelativePath || f.name,
              content: reader.result,
              language: languageForPath(f.name),
            });
          reader.onerror = () => resolve(null);
          reader.readAsText(f);
        });

      const results = (await Promise.all(readable.map(readFile))).filter(Boolean);
      if (!results.length) {
        setIsUploading(false);
        return;
      }

      socket.emit("upload-folder", { roomId, files: results });
      // isUploading is cleared when the server's "files-update" event arrives
    },
    [socket, roomId]
  );

  // ── Switch the room's shared active file ─────────────────────────────────
  const switchFile = useCallback(
    (path) => {
      if (!socket || !roomId || path === activeFile) return;
      socket.emit("switch-file", { roomId, path });
    },
    [socket, roomId, activeFile]
  );

  // ── Whiteboard action dispatchers ─────────────────────────────────────────
  const handleWhiteboardChange = useCallback(
    (elements) => {
      setWhiteboardElements(elements);
      socket?.emit("whiteboard-update", { roomId, elements });
    },
    [socket, roomId]
  );

  const handleWhiteboardDrawStep = useCallback(
    (stroke) => {
      socket?.emit("whiteboard-draw-step", { roomId, stroke });
    },
    [socket, roomId]
  );

  const handleWhiteboardCursor = useCallback(
    (cursor) => {
      socket?.emit("whiteboard-cursor", { roomId, cursor });
    },
    [socket, roomId]
  );

  const handleWhiteboardClear = useCallback(() => {
    setWhiteboardElements([]);
    socket?.emit("whiteboard-clear", { roomId });
  }, [socket, roomId]);

  // ── Switch room view mode for EVERYONE in the room ───────────────────────
  const switchViewMode = useCallback(
    (newMode) => {
      setViewMode(newMode);
      socket?.emit("view-mode-change", { roomId, viewMode: newMode });
      setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    },
    [socket, roomId]
  );

  return {
    code,
    language,
    users,
    remoteCursors,
    typingUsers,
    chatMessages,
    lineAuthors,
    files,
    activeFile,
    isUploading,
    viewMode,
    switchViewMode,
    whiteboardElements,
    setWhiteboardElements,
    remoteWhiteboardCursors,
    remoteLiveStroke,
    handleCodeChange,
    handleLanguageChange,
    handleCursorChange,
    emitLineAuthors,
    sendChatMessage,
    uploadFolder,
    createFile,
    renameFile,
    deleteFile,
    switchFile,
    handleWhiteboardChange,
    handleWhiteboardDrawStep,
    handleWhiteboardCursor,
    handleWhiteboardClear,
  };
}
