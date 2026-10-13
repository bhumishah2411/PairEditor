/**
 * App – root component.
 *
 * State machine:
 *  "landing"  → user fills in name + room ID
 *  "editor"   → full shared room workspace is shown
 */
import { useState, useEffect, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import toast, { Toaster } from "react-hot-toast";
import { MessageSquare } from "lucide-react";

import { useSocket }        from "./hooks/useSocket";
import { useCollaboration } from "./hooks/useCollaboration";
import { runCode }          from "./utils/codeRunner";

import RoomJoin    from "./components/RoomJoin";
import Toolbar     from "./components/Toolbar";
import Sidebar     from "./components/Sidebar";
import Editor      from "./components/Editor";
import Whiteboard  from "./components/Whiteboard";
import ChatPanel   from "./components/ChatPanel";
import OutputPanel from "./components/OutputPanel";
import GitHubModal from "./components/GitHubModal";

export default function App() {
  // ── Theme ────────────────────────────────────────────────────────────────
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  // ── Room / user session ──────────────────────────────────────────────────
  const [session, setSession] = useState(null); // { roomId, userName }

  // Pre-fill room from URL (e.g. shared link ?room=abc123)
  const urlRoom = new URLSearchParams(window.location.search).get("room");

  // ── Socket ───────────────────────────────────────────────────────────────
  const { socket, connected } = useSocket();

  // ── Collaboration & Shared Workspace ─────────────────────────────────────
  const {
    code,
    originalCode,
    language,
    users,
    teamUsers,
    githubRepo,
    remoteCursors,
    typingUsers,
    chatMessages,
    lineAuthors,
    files,
    activeFile,
    activeLock,
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
  } = useCollaboration({
    socket,
    roomId:   session?.roomId,
    userName: session?.userName,
  });

  // ── UI state ──────────────────────────────────────────────────────────────
  const [showChat,        setShowChat]        = useState(false);
  const [showOutput,      setShowOutput]      = useState(false);
  const [output,          setOutput]          = useState(null);
  const [isRunning,       setIsRunning]       = useState(false);
  const [showGitHubModal, setShowGitHubModal] = useState(false);

  // ── Toasts for important events only ─────────────────────────────────────
  useEffect(() => {
    if (!session || !socket) return;

    const joined = (user) => {
      if (user.id !== socket.id) {
        toast.success(`${user.name} joined the room`, {
          icon: "👋",
          style: toastStyle,
        });
      }
    };

    const left = ({ userId }) => {
      const user = teamUsers.find((u) => u.id === userId);
      if (user) toast(`${user.name} left`, { icon: "👋", style: toastStyle });
    };

    const onLockDenied = ({ path, ownerName }) => {
      toast(`"${path}" is currently locked by ${ownerName}`, {
        icon: "🔒",
        style: toastStyle,
      });
    };

    const onLockGranted = ({ path }) => {
      toast.success(`You acquired edit lock for "${path}"`, {
        icon: "✏️",
        style: toastStyle,
      });
    };

    const onLockRequestSent = ({ path }) => {
      toast.success(`Edit access requested for "${path}"`, {
        icon: "📨",
        style: toastStyle,
      });
    };

    const onLockRequestDeclined = ({ path, byUserName }) => {
      toast.error(`${byUserName} declined your edit request for "${path}"`, {
        style: toastStyle,
      });
    };

    const onLockTransferred = ({ path, toUserName }) => {
      toast(`Edit access for "${path}" transferred to ${toUserName}`, {
        icon: "🤝",
        style: toastStyle,
      });
    };

    const onOpBlocked = ({ message }) => {
      toast.error(message, { style: toastStyle });
    };

    const onEditRejected = ({ reason }) => {
      toast.error(reason || "Edit rejected (file is read-only)", { style: toastStyle });
    };

    socket.on("user-joined", joined);
    socket.on("user-left", left);
    socket.on("file-lock-denied", onLockDenied);
    socket.on("file-lock-granted", onLockGranted);
    socket.on("file-lock-request-sent", onLockRequestSent);
    socket.on("file-lock-request-declined", onLockRequestDeclined);
    socket.on("file-lock-transferred", onLockTransferred);
    socket.on("file-operation-blocked", onOpBlocked);
    socket.on("file-edit-rejected", onEditRejected);

    return () => {
      socket.off("user-joined", joined);
      socket.off("user-left", left);
      socket.off("file-lock-denied", onLockDenied);
      socket.off("file-lock-granted", onLockGranted);
      socket.off("file-lock-request-sent", onLockRequestSent);
      socket.off("file-lock-request-declined", onLockRequestDeclined);
      socket.off("file-lock-transferred", onLockTransferred);
      socket.off("file-operation-blocked", onOpBlocked);
      socket.off("file-edit-rejected", onEditRejected);
    };
  }, [socket, session, teamUsers]);

  // ── Run code ──────────────────────────────────────────────────────────────
  const handleRun = async () => {
    setIsRunning(true);
    setShowOutput(true);
    setOutput(null);
    try {
      const result = await runCode(code, language);
      setOutput(result);
    } catch (err) {
      toast.error(err.message, { style: toastStyle });
      setShowOutput(false);
    } finally {
      setIsRunning(false);
    }
  };

  // ── Join handler ──────────────────────────────────────────────────────────
  const handleJoin = ({ roomId, userName }) => {
    setSession({ roomId, userName });
    window.history.replaceState({}, "", `?room=${roomId}`);
  };

  const currentUser = teamUsers.find((u) => u.id === socket?.id);

  const localAuthorRef = useRef(null);
  useEffect(() => {
    const me = teamUsers.find((u) => u.id === socket?.id);
    if (me) {
      localAuthorRef.current = { name: me.name, color: me.color, userId: me.id };
    } else if (session) {
      localAuthorRef.current = {
        name:   session.userName,
        color:  "#6366f1",
        userId: socket?.id || "local",
      };
    }
  }, [teamUsers, socket, session]);

  const handleLinesEdited = (changedLines) => {
    if (!localAuthorRef.current && session) {
      localAuthorRef.current = {
        name:   session.userName,
        color:  "#6366f1",
        userId: socket?.id || "local",
      };
    }
    if (!localAuthorRef.current) return;
    emitLineAuthors(changedLines, localAuthorRef.current);
  };

  return (
    <>
      <Toaster position="top-right" />

      {/* ── Lock Expiring Warning Banner ── */}
      {lockExpiringWarning && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 bg-amber-500/15 border border-amber-500/40 text-amber-300 px-4 py-2 rounded-lg font-mono text-xs shadow-2xl flex items-center gap-2.5 backdrop-blur-md animate-pulse">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          <span>
            Your lock on <strong>{lockExpiringWarning.path}</strong> expires in {lockExpiringWarning.remainingSeconds}s. Type to keep editing.
          </span>
        </div>
      )}

      {/* ── Floating Incoming Edit Access Requests ── */}
      {lockRequests.length > 0 && (
        <div className="fixed top-14 right-5 z-50 flex flex-col gap-2 max-w-sm w-full">
          {lockRequests.map((req) => (
            <div
              key={`${req.path}:${req.fromUserId}`}
              className="bg-panel/95 backdrop-blur-md border border-line p-3 rounded-lg shadow-2xl flex flex-col gap-2 border-l-4"
              style={{ borderLeftColor: req.fromColor || "#6FE3A6" }}
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className="w-5 h-5 rounded flex items-center justify-center font-mono font-bold text-[10px] shrink-0"
                  style={{
                    backgroundColor: (req.fromColor || "#6FE3A6") + "22",
                    color: req.fromColor || "#6FE3A6",
                  }}
                >
                  {req.fromUserName?.charAt(0).toUpperCase()}
                </span>
                <span className="text-paper">
                  <strong>{req.fromUserName}</strong> requested edit access for{" "}
                  <strong className="text-signal">{req.path}</strong>
                </span>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1 border-t border-line/40">
                <button
                  onClick={() => respondToLockRequest(req.path, req.fromUserId, false)}
                  className="px-2.5 py-1 rounded bg-panel-raised hover:bg-danger/10 hover:text-danger text-paper-muted text-xs font-mono transition-colors"
                >
                  Decline
                </button>
                <button
                  onClick={() => respondToLockRequest(req.path, req.fromUserId, true)}
                  className="btn-signal px-3 py-1 rounded bg-signal text-canvas font-semibold text-xs font-mono shadow-sm transition-all"
                >
                  Grant access
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── GitHub Modal ── */}
      <GitHubModal
        isOpen={showGitHubModal}
        onClose={() => setShowGitHubModal(false)}
        roomId={session?.roomId}
        currentRepo={githubRepo}
        filesCount={files.length || (code ? 1 : 0)}
        currentUser={currentUser}
        code={code}
        activeFile={activeFile}
        files={files}
      />

      <div className={`h-screen flex flex-col overflow-hidden ${isDark ? "dark" : "light"}`}>
        <AnimatePresence mode="wait">
          {!session ? (
            <RoomJoin
              key="landing"
              onJoin={handleJoin}
              defaultRoom={urlRoom}
            />
          ) : (
            <div key="editor" className="flex flex-col h-full bg-canvas">
              {/* ── Top toolbar ── */}
              <Toolbar
                roomId={session.roomId}
                language={language}
                connected={connected}
                isDark={isDark}
                activeFile={activeFile}
                hasFiles={files.length > 0}
                viewMode={viewMode}
                onViewModeChange={switchViewMode}
                whiteboardElementsCount={whiteboardElements.length}
                githubRepo={githubRepo}
                onOpenGitHubModal={() => setShowGitHubModal(true)}
                onToggleTheme={() => setIsDark((d) => !d)}
                onLanguageChange={handleLanguageChange}
                onRun={handleRun}
                isRunning={isRunning}
              />

              {/* ── Main area ── */}
              <div className="flex flex-1 min-h-0">
                {/* Team members, files & activity sidebar */}
                <Sidebar
                  teamUsers={teamUsers}
                  typingUsers={typingUsers}
                  currentUserId={socket?.id}
                  activities={activities}
                  files={files}
                  activeFile={activeFile}
                  isUploading={isUploading}
                  onUploadFolder={uploadFolder}
                  onCreateFile={createFile}
                  onRenameFile={renameFile}
                  onDeleteFile={deleteFile}
                  onSelectFile={switchFile}
                  onOpenGitHubModal={() => setShowGitHubModal(true)}
                />

                {/* Editor column (shown in 'code' or 'split' view) */}
                <div
                  className={`flex flex-col min-w-0 ${
                    viewMode === "code"
                      ? "flex-1"
                      : viewMode === "split"
                      ? "flex-1 border-r border-line"
                      : "hidden"
                  }`}
                >
                  <Editor
                    code={code}
                    originalCode={originalCode}
                    language={language}
                    isDark={isDark}
                    users={users}
                    remoteCursors={remoteCursors}
                    lineAuthors={lineAuthors}
                    currentUserId={socket?.id}
                    currentUser={currentUser}
                    onChange={handleCodeChange}
                    onCursorChange={handleCursorChange}
                    onLinesEdited={handleLinesEdited}
                    activeFile={activeFile}
                    isLockedByMe={isLockedByMe}
                    isLockedByOther={isLockedByOther}
                    isUnlocked={isUnlocked}
                    lockOwner={activeLock}
                    onAcquireLock={acquireLock}
                    onReleaseLock={releaseLock}
                    onRequestLock={requestLock}
                  />

                  {/* Output panel (animated slide-up) */}
                  <AnimatePresence>
                    {showOutput && (
                      <OutputPanel
                        result={output}
                        isRunning={isRunning}
                        onClose={() => setShowOutput(false)}
                      />
                    )}
                  </AnimatePresence>
                </div>

                {/* Whiteboard column (shown in 'split' or 'whiteboard' view) */}
                <div
                  className={`flex flex-col min-w-0 h-full relative ${
                    viewMode === "whiteboard"
                      ? "flex-1"
                      : viewMode === "split"
                      ? "flex-1"
                      : "hidden"
                  }`}
                >
                  <Whiteboard
                    roomId={session.roomId}
                    currentUser={currentUser}
                    elements={whiteboardElements}
                    onChange={handleWhiteboardChange}
                    onDrawStep={handleWhiteboardDrawStep}
                    remoteLiveStroke={remoteLiveStroke}
                    remoteCursors={remoteWhiteboardCursors}
                    onCursorMove={handleWhiteboardCursor}
                    onClear={handleWhiteboardClear}
                    isDark={isDark}
                  />
                </div>

                {/* Chat panel (animated slide-in) */}
                <AnimatePresence>
                  {showChat && (
                    <ChatPanel
                      messages={chatMessages}
                      onSend={sendChatMessage}
                      onClose={() => setShowChat(false)}
                      currentUser={currentUser}
                    />
                  )}
                </AnimatePresence>
              </div>

              {/* ── Floating chat toggle button ── */}
              <button
                id="btn-toggle-chat"
                onClick={() => setShowChat((v) => !v)}
                className="btn-signal fixed bottom-5 right-5 w-12 h-12 flex items-center justify-center rounded-lg bg-signal shadow-lg transition-all z-40"
                title="Toggle chat"
              >
                <MessageSquare size={20} className="text-canvas" />
                {chatMessages.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 min-w-[18px] px-1 bg-danger rounded-full text-[9px] flex items-center justify-center font-mono font-bold text-white">
                    {chatMessages.length > 9 ? "9+" : chatMessages.length}
                  </span>
                )}
              </button>
            </div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

const toastStyle = {
  background: "#161B22",
  color: "#EDEFF2",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: "6px",
  fontSize: "13px",
  fontFamily: "'JetBrains Mono', monospace",
};
