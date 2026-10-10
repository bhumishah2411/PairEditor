/**
 * App – root component.
 *
 * State machine:
 *  "landing"  → user fills in name + room ID
 *  "editor"   → full workspace is shown (personal or collaborative session)
 *
 * URL param ?room=<id> pre-fills the room ID so sharing a link works.
 */
import { useState, useEffect, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import toast, { Toaster } from "react-hot-toast";
import { MessageSquare } from "lucide-react";

import { useSocket }        from "./hooks/useSocket";
import { useCollaboration } from "./hooks/useCollaboration";
import { runCode }          from "./utils/codeRunner";

import RoomJoin       from "./components/RoomJoin";
import Toolbar        from "./components/Toolbar";
import Sidebar        from "./components/Sidebar";
import Editor         from "./components/Editor";
import Whiteboard     from "./components/Whiteboard";
import ChatPanel      from "./components/ChatPanel";
import OutputPanel    from "./components/OutputPanel";
import CollabRequests from "./components/CollabRequests";

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

  // ── Collaboration & Workspace ─────────────────────────────────────────────
  const {
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
    respondToRequest,
    leaveSession,
  } = useCollaboration({
    socket,
    roomId:   session?.roomId,
    userName: session?.userName,
  });

  // ── UI state ──────────────────────────────────────────────────────────────
  const [showChat,   setShowChat]   = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [output,     setOutput]     = useState(null);
  const [isRunning,  setIsRunning]  = useState(false);

  // ── Toasts for team room & session events ─────────────────────────────────
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

    const onSessionMemberJoined = ({ member }) => {
      if (member.id !== socket.id) {
        toast.success(`${member.name} joined your session!`, {
          icon: "🤝",
          style: toastStyle,
        });
      }
    };

    const onSessionMemberLeft = ({ userName }) => {
      toast(`${userName || "A member"} left the session`, {
        icon: "👋",
        style: toastStyle,
      });
    };

    const onCollabDeclined = ({ byName, reason }) => {
      toast.error(`${byName || "Peer"} declined your request${reason ? ` (${reason})` : ""}`, {
        style: toastStyle,
      });
    };

    const onCollabRequestSent = () => {
      toast.success("Collaboration request sent", {
        icon: "📨",
        style: toastStyle,
      });
    };

    socket.on("user-joined", joined);
    socket.on("user-left", left);
    socket.on("session-member-joined", onSessionMemberJoined);
    socket.on("session-member-left", onSessionMemberLeft);
    socket.on("collab-declined", onCollabDeclined);
    socket.on("collab-request-sent", onCollabRequestSent);

    return () => {
      socket.off("user-joined", joined);
      socket.off("user-left", left);
      socket.off("session-member-joined", onSessionMemberJoined);
      socket.off("session-member-left", onSessionMemberLeft);
      socket.off("collab-declined", onCollabDeclined);
      socket.off("collab-request-sent", onCollabRequestSent);
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

  const currentUser =
    teamUsers.find((u) => u.id === socket?.id) ||
    users.find((u) => u.id === socket?.id);

  /**
   * Stable ref always holding the local user's author info.
   */
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

  /**
   * Called by Editor when the local user touches specific line numbers.
   */
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <Toaster position="top-right" />

      {/* Floating incoming collaboration request popups */}
      <CollabRequests
        requests={incomingRequests}
        onRespond={respondToRequest}
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
                workspaceType={workspaceType}
                workspaceId={workspaceId}
                sessionMembers={sessionMembers}
                onLeaveSession={leaveSession}
                language={language}
                connected={connected}
                isDark={isDark}
                activeFile={activeFile}
                hasFiles={files.length > 0}
                viewMode={viewMode}
                onViewModeChange={switchViewMode}
                whiteboardElementsCount={whiteboardElements.length}
                onToggleTheme={() => setIsDark((d) => !d)}
                onLanguageChange={handleLanguageChange}
                onRun={handleRun}
                isRunning={isRunning}
              />

              {/* ── Main area ── */}
              <div className="flex flex-1 min-h-0">
                {/* Team members & files sidebar */}
                <Sidebar
                  teamUsers={teamUsers}
                  typingUsers={typingUsers}
                  currentUserId={socket?.id}
                  workspaceType={workspaceType}
                  sessionId={sessionId}
                  outgoingRequests={outgoingRequests}
                  onSendCollabRequest={sendCollabRequest}
                  files={files}
                  activeFile={activeFile}
                  isUploading={isUploading}
                  onUploadFolder={uploadFolder}
                  onCreateFile={createFile}
                  onRenameFile={renameFile}
                  onDeleteFile={deleteFile}
                  onSelectFile={switchFile}
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
                className="btn-signal fixed bottom-5 right-5 w-12 h-12 flex items-center justify-center rounded-lg bg-signal shadow-lg transition-all z-50"
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
