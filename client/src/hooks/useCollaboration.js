/**
 * useCollaboration – orchestrates all real-time collaboration state.
 *
 * Handles:
 *  - Personal workspaces vs shared session workspaces
 *  - Joining a team room and receiving initial workspace state
 *  - Sending/receiving code changes (scoped to current workspace)
 *  - Cursor tracking & line authorship blame (scoped to current workspace)
 *  - Multi-file explorer & upload actions
 *  - Whiteboard drawing & syncing (scoped to current workspace)
 *  - Team-wide chat and presence
 *  - Collaboration invites: send request, accept/decline, leave session
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { languageForPath, shouldIncludeFile } from "../utils/fileTree";

export function useCollaboration({ socket, roomId, userName }) {
  // ── Current Workspace Content ─────────────────────────────────────────────
  const [code, setCode]               = useState("// Start coding here...\n");
  const [language, setLanguageSt]     = useState("javascript");
  const [lineAuthors, setLineAuthors] = useState({});
  const [files, setFiles]             = useState([]);
  const [activeFile, setActiveFile]   = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  // ── Scoped Workspace Meta ─────────────────────────────────────────────────
  const [workspaceType, setWorkspaceType]   = useState("personal"); // "personal" | "session"
  const [workspaceId, setWorkspaceId]       = useState(null);
  const [sessionId, setSessionId]           = useState(null);
  const [sessionMembers, setSessionMembers] = useState([]);

  // ── Team Presence & Collaboration Requests ────────────────────────────────
  const [teamUsers, setTeamUsers]               = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState(new Set());

  // ── Cursors, Typing & Chat ────────────────────────────────────────────────
  const [remoteCursors, setRemoteCursors] = useState({});
  const [typingUsers, setTypingUsers]     = useState(new Set());
  const [chatMessages, setChatMessages]   = useState([]);

  // ── Whiteboard collaborative state ────────────────────────────────────────
  const [whiteboardElements, setWhiteboardElements]           = useState([]);
  const [remoteWhiteboardCursors, setRemoteWhiteboardCursors] = useState({});
  const [remoteLiveStroke, setRemoteLiveStroke]               = useState(null);

  // ── Workspace-scoped synchronized view mode ('code' | 'split' | 'whiteboard')
  const [viewMode, setViewMode] = useState("code");

  // Prevent looping our own code-change back into the editor
  const isRemoteChange = useRef(false);
  const typingTimer    = useRef(null);
  const hasJoined      = useRef(false);
  const prevUserStatuses = useRef(new Map());

  // ── Active workspace users (for Monaco cursor/blame rendering) ───────────
  const users = useMemo(() => {
    if (workspaceType === "personal") {
      const me = teamUsers.find((u) => u.id === socket?.id);
      return me ? [me] : [];
    }
    // In session: members sharing this session
    if (sessionId) {
      return teamUsers.filter((u) => u.sessionId === sessionId);
    }
    return teamUsers.filter((u) => u.workspaceType === "session");
  }, [workspaceType, sessionId, teamUsers, socket?.id]);

  // ── Socket event listeners ────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !roomId || hasJoined.current) return;
    hasJoined.current = true;

    // Join room for team presence and chat
    socket.emit("join-room", { roomId, userName });

    // Initial state on join
    const handleRoomState = (data) => {
      isRemoteChange.current = true;
      if (data.code !== undefined) setCode(data.code);
      if (data.language) setLanguageSt(data.language);
      if (data.lineAuthors) setLineAuthors(data.lineAuthors);
      if (data.files) setFiles(data.files);
      if (data.activeFile !== undefined) setActiveFile(data.activeFile);
      if (data.whiteboard) setWhiteboardElements(data.whiteboard);
      if (data.viewMode) setViewMode(data.viewMode);
      if (data.workspaceType) setWorkspaceType(data.workspaceType);
      if (data.workspaceId) setWorkspaceId(data.workspaceId);
      if (data.users) {
        setTeamUsers(data.users);
        data.users.forEach((u) => {
          prevUserStatuses.current.set(u.id, `${u.workspaceType || "personal"}:${u.sessionId || ""}`);
        });
      }
    };

    // Full workspace replacement (on joining room, accepting session, or leaving session)
    const handleWorkspaceState = (data) => {
      isRemoteChange.current = true;
      if (data.code !== undefined) setCode(data.code);
      if (data.language) setLanguageSt(data.language);
      setLineAuthors(data.lineAuthors || {});
      setFiles(data.files || []);
      setActiveFile(data.activeFile !== undefined ? data.activeFile : null);
      setWhiteboardElements(data.whiteboard || []);
      if (data.viewMode) setViewMode(data.viewMode);
      setWorkspaceType(data.workspaceType || "personal");
      setWorkspaceId(data.workspaceId || null);

      // Reset cursors and transient states for fresh workspace
      setRemoteCursors({});
      setRemoteWhiteboardCursors({});
      setRemoteLiveStroke(null);
      setTypingUsers(new Set());
    };

    socket.on("room-state", handleRoomState);
    socket.on("workspace-state", handleWorkspaceState);

    // Team presence updates
    const handlePresenceUpdate = (allUsers) => {
      setTeamUsers(allUsers);
      setOutgoingRequests((prev) => {
        let changed = false;
        const next = new Set(prev);
        allUsers.forEach((u) => {
          const prevStatus = prevUserStatuses.current.get(u.id);
          const currentStatus = `${u.workspaceType || "personal"}:${u.sessionId || ""}`;
          // If user's session status changed or user is in my session, clear outgoing request
          if (
            (prevStatus !== undefined && prevStatus !== currentStatus) ||
            (sessionId && u.sessionId === sessionId)
          ) {
            if (next.delete(u.id)) {
              changed = true;
            }
          }
          prevUserStatuses.current.set(u.id, currentStatus);
        });
        return changed ? next : prev;
      });
    };

    socket.on("users-update", handlePresenceUpdate);
    socket.on("presence-update", handlePresenceUpdate);

    socket.on("user-joined", (user) => {
      setTeamUsers((prev) => [...prev.filter((u) => u.id !== user.id), user]);
    });

    socket.on("user-left", ({ userId }) => {
      setTeamUsers((prev) => prev.filter((u) => u.id !== userId));
      setOutgoingRequests((prev) => {
        if (!prev.has(userId)) return prev;
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
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

    // ── Session Membership Updates ──────────────────────────────────────────
    socket.on("session-update", ({ sessionId: sid, members: m }) => {
      setSessionId(sid);
      setSessionMembers(m || []);
      setWorkspaceType(sid ? "session" : "personal");
      if (m && m.length > 0) {
        setOutgoingRequests((prev) => {
          if (!prev.size) return prev;
          const next = new Set(prev);
          m.forEach((mem) => next.delete(mem.id));
          return next.size === prev.size ? prev : next;
        });
      }
    });

    socket.on("session-ended", () => {
      setSessionId(null);
      setSessionMembers([]);
      setWorkspaceType("personal");
      setOutgoingRequests(new Set());
    });

    // ── Collaboration Request Listeners ─────────────────────────────────────
    socket.on("collab-request-received", (req) => {
      setIncomingRequests((prev) => {
        if (prev.some((r) => r.fromUserId === req.fromUserId)) return prev;
        return [...prev, req];
      });
    });

    socket.on("collab-request-cancelled", ({ fromUserId }) => {
      setIncomingRequests((prev) => prev.filter((r) => r.fromUserId !== fromUserId));
    });

    socket.on("collab-request-sent", ({ toUserId }) => {
      setOutgoingRequests((prev) => new Set([...prev, toUserId]));
    });

    socket.on("collab-request-resolved", ({ toUserId }) => {
      setOutgoingRequests((prev) => {
        const next = new Set(prev);
        next.delete(toUserId);
        return next;
      });
    });

    socket.on("collab-declined", ({ byUserId }) => {
      setOutgoingRequests((prev) => {
        const next = new Set(prev);
        next.delete(byUserId);
        return next;
      });
    });

    // ── Workspace Editor Scoped Listeners ───────────────────────────────────
    socket.on("code-update", ({ code: c, senderId }) => {
      if (senderId === socket.id) return;
      isRemoteChange.current = true;
      setCode(c);
    });

    socket.on("language-update", ({ language: l }) => setLanguageSt(l));

    socket.on("cursor-update", ({ userId, cursor }) => {
      setRemoteCursors((prev) => ({ ...prev, [userId]: cursor }));
    });

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

    socket.on("line-author-update", ({ lines }) => {
      setLineAuthors((prev) => {
        const next = { ...prev };
        lines.forEach(({ line, name, color, userId }) => {
          next[line] = { name, color, userId };
        });
        return next;
      });
    });

    socket.on("files-update", ({ files: f, activeFile: af }) => {
      setFiles(f);
      setActiveFile(af);
      setIsUploading(false);
    });

    socket.on("rename-file-error", ({ message }) => {
      window.alert(message || "Rename failed.");
    });

    socket.on("active-file-changed", ({ path, code: c, language: l, lineAuthors: la }) => {
      isRemoteChange.current = true;
      setActiveFile(path);
      setCode(c);
      setLanguageSt(l);
      setLineAuthors(la || {});
    });

    // ── Team Chat ───────────────────────────────────────────────────────────
    socket.on("chat-message", (msg) => {
      setChatMessages((prev) => [...prev, msg]);
    });

    // ── Workspace Whiteboard Listeners ──────────────────────────────────────
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

    // ── Synchronized View Mode (scoped to workspace) ────────────────────────
    socket.on("view-mode-update", ({ viewMode: vm }) => {
      if (vm) {
        setViewMode(vm);
        setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
      }
    });

    return () => {
      socket.off("room-state", handleRoomState);
      socket.off("workspace-state", handleWorkspaceState);
      socket.off("users-update");
      socket.off("presence-update");
      socket.off("user-joined");
      socket.off("user-left");
      socket.off("session-update");
      socket.off("session-ended");
      socket.off("collab-request-received");
      socket.off("collab-request-cancelled");
      socket.off("collab-request-sent");
      socket.off("collab-request-resolved");
      socket.off("collab-declined");
      socket.off("code-update");
      socket.off("language-update");
      socket.off("cursor-update");
      socket.off("user-typing");
      socket.off("user-stopped-typing");
      socket.off("line-author-update");
      socket.off("files-update");
      socket.off("rename-file-error");
      socket.off("active-file-changed");
      socket.off("chat-message");
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
      socket?.emit("code-change", { code: newCode });

      // Debounce typing indicator
      socket?.emit("typing-start", {});
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        socket?.emit("typing-stop", {});
      }, 1500);
    },
    [socket]
  );

  // ── Emit language change ─────────────────────────────────────────────────
  const handleLanguageChange = useCallback(
    (lang) => {
      setLanguageSt(lang);
      socket?.emit("language-change", { language: lang });
    },
    [socket]
  );

  // ── Emit cursor move ─────────────────────────────────────────────────────
  const handleCursorChange = useCallback(
    (cursor) => {
      socket?.emit("cursor-move", { cursor });
    },
    [socket]
  );

  // ── Emit line-author update ───────────────────────────────────────────────
  const emitLineAuthors = useCallback(
    (lines, authorInfo) => {
      if (!socket || !lines.length) return;

      const payload = lines.map((line) => ({ line, ...authorInfo }));

      setLineAuthors((prev) => {
        const next = { ...prev };
        payload.forEach(({ line, name, color, userId }) => {
          next[line] = { name, color, userId };
        });
        return next;
      });

      socket.emit("line-author-update", { lines: payload });
    },
    [socket]
  );

  // ── Team Chat ────────────────────────────────────────────────────────────
  const sendChatMessage = useCallback(
    (message) => {
      socket?.emit("chat-message", { message });
    },
    [socket]
  );

  // ── File Management ──────────────────────────────────────────────────────
  const createFile = useCallback(
    (fileName) => {
      if (!socket) return;
      const name = String(fileName || "").trim() || "untitled.js";
      const normalized = name.startsWith("/") ? name.slice(1) : name;
      const safePath = normalized.includes(".") ? normalized : `${normalized}.js`;

      socket.emit("create-file", {
        path: safePath,
        language: (() => {
          const ext = safePath.split(".").pop()?.toLowerCase();
          if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
          if (["ts", "tsx"].includes(ext)) return "typescript";
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
      if (!socket) return;
      socket.emit("delete-file", { path: String(path || "").replace(/^\/+/, "") });
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

  const switchFile = useCallback(
    (path) => {
      if (!socket || path === activeFile) return;
      socket.emit("switch-file", { path });
    },
    [socket, activeFile]
  );

  // ── Whiteboard action dispatchers ─────────────────────────────────────────
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

  // ── Workspace View Mode ───────────────────────────────────────────────────
  const switchViewMode = useCallback(
    (newMode) => {
      setViewMode(newMode);
      socket?.emit("view-mode-change", { viewMode: newMode });
      setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    },
    [socket]
  );

  // ── Collaboration session controls ────────────────────────────────────────
  const sendCollabRequest = useCallback(
    (toUserId) => {
      if (!socket || !toUserId) return;
      setOutgoingRequests((prev) => new Set([...prev, toUserId]));
      socket.emit("collab-request", { toUserId });
    },
    [socket]
  );

  const cancelCollabRequest = useCallback(
    (toUserId) => {
      if (!socket || !toUserId) return;
      setOutgoingRequests((prev) => {
        const next = new Set(prev);
        next.delete(toUserId);
        return next;
      });
      socket.emit("collab-request-cancel", { toUserId });
    },
    [socket]
  );

  const respondToRequest = useCallback(
    (fromUserId, accept) => {
      if (!socket || !fromUserId) return;
      setIncomingRequests((prev) => prev.filter((r) => r.fromUserId !== fromUserId));
      socket.emit("collab-respond", { fromUserId, accept });
    },
    [socket]
  );

  const leaveSession = useCallback(() => {
    if (!socket) return;
    socket.emit("leave-session", {});
  }, [socket]);

  return {
    code,
    language,
    users,
    teamUsers,
    workspaceType,
    workspaceId,
    sessionId,
    sessionMembers,
    incomingRequests,
    outgoingRequests,
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
    sendCollabRequest,
    cancelCollabRequest,
    respondToRequest,
    leaveSession,
  };
}
