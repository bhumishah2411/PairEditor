/**
 * useCollaboration – orchestrates shared-room real-time collaboration.
 *
 * Architecture:
 *  - ONE shared workspace per room for all members.
 *  - Each member has their own local active file.
 *  - Single writer per file via server-managed file locks.
 *  - Live content updates streamed to anyone viewing the same file.
 *  - Line authorship blame and remote cursors.
 *  - Activity feed logging real-time changes.
 *  - Real-time shared whiteboard and chat.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { languageForPath, shouldIncludeFile } from "../utils/fileTree";

export function useCollaboration({ socket, roomId, userName }) {
  // ── Active File & Content (Local to this user) ────────────────────────────
  const [activeFile, setActiveFile]     = useState(null);
  const [code, setCode]                 = useState("// Start coding here...\n");
  const [language, setLanguageSt]       = useState("javascript");
  const [originalCode, setOriginalCode] = useState(null);
  const [lineAuthors, setLineAuthors]   = useState({});
  const [isUploading, setIsUploading]   = useState(false);

  // ── Shared Room State ──────────────────────────────────────────────────────
  const [files, setFiles]               = useState([]);
  const [fileLocks, setFileLocks]       = useState({}); // path -> { userId, userName, color, lockedAt }
  const [githubRepo, setGithubRepo]     = useState(null);
  const [activities, setActivities]     = useState([]);

  // ── Lock Workflow State ────────────────────────────────────────────────────
  const [lockRequests, setLockRequests]                 = useState([]); // { path, fromUserId, fromUserName, fromColor }
  const [lockExpiringWarning, setLockExpiringWarning]   = useState(null); // { path, remainingSeconds }

  // ── Team Presence & Real-time Cursors ──────────────────────────────────────
  const [teamUsers, setTeamUsers]               = useState([]);
  const [remoteCursors, setRemoteCursors]       = useState({});
  const [typingUsers, setTypingUsers]           = useState(new Set());
  const [chatMessages, setChatMessages]         = useState([]);

  // ── Shared Whiteboard ──────────────────────────────────────────────────────
  const [whiteboardElements, setWhiteboardElements]           = useState([]);
  const [remoteWhiteboardCursors, setRemoteWhiteboardCursors] = useState({});
  const [remoteLiveStroke, setRemoteLiveStroke]               = useState(null);

  // ── Room-wide View Mode ('code' | 'split' | 'whiteboard') ──────────────────
  const [viewMode, setViewMode] = useState("code");

  // Prevent local edit loops
  const isRemoteChange   = useRef(false);
  const typingTimer      = useRef(null);
  const hasJoined        = useRef(false);
  const activeFileRef    = useRef(activeFile);

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);

  // ── Socket event listeners ────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !roomId || hasJoined.current) return;
    hasJoined.current = true;

    // Join room
    socket.emit("join-room", { roomId, userName });

    const handleReconnect = () => {
      socket.emit("join-room", { roomId, userName });
    };
    socket.on("connect", handleReconnect);

    // Initial full room state received upon joining
    const handleRoomState = (data) => {
      isRemoteChange.current = true;
      if (data.files) setFiles(data.files);
      if (data.locks) setFileLocks(data.locks);
      if (data.activeFile) setActiveFile(data.activeFile);
      if (data.activeFileContent) {
        setCode(data.activeFileContent.code ?? "");
        setLanguageSt(data.activeFileContent.language || "plaintext");
        setOriginalCode(data.activeFileContent.originalCode ?? null);
        setLineAuthors(data.activeFileContent.lineAuthors || {});
      }
      if (data.whiteboard) setWhiteboardElements(data.whiteboard);
      if (data.viewMode) setViewMode(data.viewMode);
      if (data.githubRepo !== undefined) setGithubRepo(data.githubRepo);
      if (data.users) setTeamUsers(data.users);
      if (data.activities) setActivities(data.activities);
    };

    socket.on("room-state", handleRoomState);

    // Presence updates
    const handlePresenceUpdate = (allUsers) => setTeamUsers(allUsers);
    socket.on("users-update", handlePresenceUpdate);
    socket.on("presence-update", handlePresenceUpdate);

    socket.on("user-joined", (user) => {
      setTeamUsers((prev) => [...prev.filter((u) => u.id !== user.id), user]);
    });

    socket.on("user-left", ({ userId }) => {
      setTeamUsers((prev) => prev.filter((u) => u.id !== userId));
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

    // File list updates (with updated locks and viewers)
    socket.on("files-update", ({ files: f }) => {
      if (f) setFiles(f);
      setIsUploading(false);
    });

    // Locks update (Spec 7)
    const handleLocksUpdate = ({ locks: l, files: f }) => {
      if (l) setFileLocks(l);
      if (f) setFiles(f);
    };
    socket.on("file-locks-update", handleLocksUpdate);
    socket.on("file-locks-updated", handleLocksUpdate);

    // Content received when THIS socket opened a file
    socket.on("file-opened", ({ path, code: c, language: l, originalCode: orig, lineAuthors: la }) => {
      isRemoteChange.current = true;
      setActiveFile(path);
      setCode(c ?? "");
      setLanguageSt(l || "plaintext");
      setOriginalCode(orig !== undefined ? orig : null);
      setLineAuthors(la || {});
      setRemoteCursors({});
      setTypingUsers(new Set());
    });

    // Live update broadcast when the lock owner modifies the file I am viewing
    socket.on("file-content-update", ({ path, code: c }) => {
      if (path === activeFileRef.current) {
        isRemoteChange.current = true;
        setCode(c);
      }
    });

    // Line blame updates for the active file
    socket.on("line-author-update", ({ path, lines }) => {
      if (path === activeFileRef.current && Array.isArray(lines)) {
        setLineAuthors((prev) => {
          const next = { ...prev };
          lines.forEach(({ line, name, color, userId }) => {
            next[line] = { name, color, userId };
          });
          return next;
        });
      }
    });

    // Cursor movement of other members on this file
    socket.on("cursor-update", ({ path, userId, cursor }) => {
      if (path === activeFileRef.current && userId !== socket.id) {
        setRemoteCursors((prev) => ({ ...prev, [userId]: cursor }));
      }
    });

    socket.on("user-typing", ({ userId, path }) => {
      if (path === activeFileRef.current && userId !== socket.id) {
        setTypingUsers((prev) => new Set([...prev, userId]));
      }
    });

    socket.on("user-stopped-typing", ({ userId, path }) => {
      if (path === activeFileRef.current) {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    });

    // Lock notifications
    socket.on("file-lock-expiring", ({ path, remainingSeconds }) => {
      setLockExpiringWarning({ path, remainingSeconds });
    });

    socket.on("file-lock-lost", () => {
      setLockExpiringWarning(null);
    });

    socket.on("file-lock-request-received", (req) => {
      setLockRequests((prev) => {
        if (prev.some((r) => r.fromUserId === req.fromUserId && r.path === req.path)) return prev;
        return [...prev, req];
      });
    });

    socket.on("file-lock-request-expired", ({ path }) => {
      setLockRequests((prev) => prev.filter((r) => r.path !== path));
    });

    // File rename/delete transitions
    socket.on("file-renamed", ({ oldPath, newPath }) => {
      if (activeFileRef.current === oldPath) {
        setActiveFile(newPath);
      }
    });

    socket.on("file-deleted", ({ path, nextPath, nextFile }) => {
      if (activeFileRef.current === path) {
        if (nextPath && nextFile) {
          isRemoteChange.current = true;
          setActiveFile(nextPath);
          setCode(nextFile.code ?? "");
          setLanguageSt(nextFile.language || "plaintext");
          setOriginalCode(nextFile.originalCode ?? null);
          setLineAuthors(nextFile.lineAuthors || {});
        } else {
          setActiveFile(null);
          setCode("// No file selected\n");
          setLanguageSt("plaintext");
          setOriginalCode(null);
          setLineAuthors({});
        }
      }
    });

    // Activity feed events
    socket.on("activity-event", (event) => {
      setActivities((prev) => [event, ...prev.slice(0, 99)]);
    });

    // Chat
    socket.on("chat-message", (msg) => {
      setChatMessages((prev) => [...prev, msg]);
    });

    // Whiteboard
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

    // Synchronized view mode
    socket.on("view-mode-update", ({ viewMode: vm }) => {
      if (vm) {
        setViewMode(vm);
        setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
      }
    });

    // GitHub
    socket.on("github-repo-linked", (repoData) => {
      setGithubRepo(repoData || null);
    });

    return () => {
      socket.off("connect", handleReconnect);
      socket.off("room-state", handleRoomState);
      socket.off("users-update");
      socket.off("presence-update");
      socket.off("user-joined");
      socket.off("user-left");
      socket.off("files-update");
      socket.off("file-locks-update");
      socket.off("file-locks-updated");
      socket.off("file-lock-status");
      socket.off("file-opened");
      socket.off("file-content-update");
      socket.off("line-author-update");
      socket.off("cursor-update");
      socket.off("user-typing");
      socket.off("user-stopped-typing");
      socket.off("file-lock-expiring");
      socket.off("file-lock-lost");
      socket.off("file-lock-request-received");
      socket.off("file-lock-request-expired");
      socket.off("file-renamed");
      socket.off("file-deleted");
      socket.off("activity-event");
      socket.off("chat-message");
      socket.off("whiteboard-update");
      socket.off("whiteboard-draw-step");
      socket.off("whiteboard-cursor-update");
      socket.off("view-mode-update");
      socket.off("github-repo-linked");
    };
  }, [socket, roomId, userName]);

  // ── Emit code change ───────────────────────────────────────────────────────
  const handleCodeChange = useCallback(
    (newCode) => {
      if (isRemoteChange.current) {
        isRemoteChange.current = false;
        return;
      }
      setCode(newCode);
      if (activeFile) {
        socket?.emit("code-change", { path: activeFile, code: newCode });

        // Debounce typing indicator
        socket?.emit("typing-start", { path: activeFile });
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => {
          socket?.emit("typing-stop", { path: activeFile });
        }, 1500);
      }
    },
    [socket, activeFile]
  );

  // ── Emit language change ───────────────────────────────────────────────────
  const handleLanguageChange = useCallback(
    (lang) => {
      setLanguageSt(lang);
    },
    []
  );

  // ── Emit cursor move ───────────────────────────────────────────────────────
  const handleCursorChange = useCallback(
    (cursor) => {
      if (activeFile) {
        socket?.emit("cursor-move", { path: activeFile, cursor });
      }
    },
    [socket, activeFile]
  );

  // ── Emit line authorship ───────────────────────────────────────────────────
  const emitLineAuthors = useCallback(
    (lines, authorInfo) => {
      if (!socket || !lines.length || !activeFile) return;

      const payload = lines.map((line) => ({ line, ...authorInfo }));
      setLineAuthors((prev) => {
        const next = { ...prev };
        payload.forEach(({ line, name, color, userId }) => {
          next[line] = { name, color, userId };
        });
        return next;
      });

      socket.emit("line-author-update", { path: activeFile, lines: payload });
    },
    [socket, activeFile]
  );

  // ── File Lock Management ───────────────────────────────────────────────────
  const acquireLock = useCallback(
    (targetPath) => {
      const p = targetPath || activeFile;
      if (!socket || !p) return;
      socket.emit("file-lock-acquire", { path: p });
    },
    [socket, activeFile]
  );

  const releaseLock = useCallback(
    (targetPath) => {
      const p = targetPath || activeFile;
      if (!socket || !p) return;
      socket.emit("file-lock-release", { path: p });
      socket.emit("file-release-lock", { path: p });
      setLockExpiringWarning(null);
    },
    [socket, activeFile]
  );

  const requestLock = useCallback(
    (targetPath) => {
      const p = targetPath || activeFile;
      if (!socket || !p) return;
      socket.emit("file-lock-request", { path: p });
    },
    [socket, activeFile]
  );

  const respondToLockRequest = useCallback(
    (path, fromUserId, accept) => {
      if (!socket || !path || !fromUserId) return;
      setLockRequests((prev) => prev.filter((r) => !(r.path === path && r.fromUserId === fromUserId)));
      socket.emit("file-lock-respond", { path, fromUserId, accept });
    },
    [socket]
  );

  // ── Switch Active File (per member) ────────────────────────────────────────
  const switchFile = useCallback(
    (path) => {
      if (!socket || !path || path === activeFile) return;
      socket.emit("file-open", { path });
    },
    [socket, activeFile]
  );

  // ── File Management ────────────────────────────────────────────────────────
  const createFile = useCallback(
    (fileName) => {
      if (!socket) return;
      const name = String(fileName || "").trim() || "untitled.js";
      const normalized = name.startsWith("/") ? name.slice(1) : name;
      const safePath = normalized.includes(".") ? normalized : `${normalized}.js`;

      socket.emit("create-file", {
        path: safePath,
        language: languageForPath(safePath),
        code: "",
      });
    },
    [socket]
  );

  const renameFile = useCallback(
    (oldPath, newName) => {
      if (!socket) return;
      const trimmed = String(newName || "").trim();
      if (!trimmed) return;
      const normalizedOld = String(oldPath || "").replace(/^\/+/, "");
      const baseDir = normalizedOld.includes("/")
        ? normalizedOld.slice(0, normalizedOld.lastIndexOf("/") + 1)
        : "";
      const newPath = `${baseDir}${String(trimmed).replace(/^\/+/, "")}`;
      if (!newPath || newPath === normalizedOld) return;

      socket.emit("rename-file", { oldPath: normalizedOld, newPath });
    },
    [socket]
  );

  const deleteFile = useCallback(
    (path) => {
      if (!socket || !path) return;
      socket.emit("delete-file", { path: String(path).replace(/^\/+/, "") });
    },
    [socket]
  );

  const uploadFolder = useCallback(
    async (fileList) => {
      if (!socket || !fileList?.length) return;
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

      socket.emit("upload-folder", { files: results });
    },
    [socket]
  );

  // ── Team Chat ──────────────────────────────────────────────────────────────
  const sendChatMessage = useCallback(
    (message) => {
      socket?.emit("chat-message", { message });
    },
    [socket]
  );

  // ── Whiteboard ─────────────────────────────────────────────────────────────
  const handleWhiteboardChange = useCallback(
    (elements) => {
      setWhiteboardElements(elements);
      socket?.emit("whiteboard-update", { elements });
    },
    [socket]
  );

  const handleWhiteboardDrawStep = useCallback(
    (stroke) => {
      socket?.emit("whiteboard-draw-step", { stroke });
    },
    [socket]
  );

  const handleWhiteboardCursor = useCallback(
    (cursor) => {
      socket?.emit("whiteboard-cursor", { cursor });
    },
    [socket]
  );

  const handleWhiteboardClear = useCallback(() => {
    setWhiteboardElements([]);
    socket?.emit("whiteboard-clear", {});
  }, [socket]);

  // ── View Mode ──────────────────────────────────────────────────────────────
  const switchViewMode = useCallback(
    (newMode) => {
      setViewMode(newMode);
      socket?.emit("view-mode-change", { viewMode: newMode });
      setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    },
    [socket]
  );

  // ── Lock status helper for activeFile ──────────────────────────────────────
  const activeLock = activeFile ? fileLocks[activeFile] || null : null;
  const isLockedByMe = Boolean(activeLock && activeLock.userId === socket?.id);
  const isLockedByOther = Boolean(activeLock && activeLock.userId !== socket?.id);
  const isUnlocked = !activeLock;

  return {
    code,
    originalCode,
    setOriginalCode,
    language,
    users: teamUsers, // all members in room are active
    teamUsers,
    githubRepo,
    setGithubRepo,
    remoteCursors,
    typingUsers,
    chatMessages,
    lineAuthors,
    files,
    activeFile,
    fileLocks,
    activeLock,
    hasWriteAccess: isLockedByMe,
    isLockedByMe,
    isLockedByOther,
    isUnlocked,
    acquireLock,
    releaseLock,
    requestLock,
    respondToLockRequest,
    lockRequests,
    lockExpiringWarning,
    activities,
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
