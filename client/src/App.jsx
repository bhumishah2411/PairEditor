/**
 * App – root component.
 *
 * State machine:
 *  "landing"  → user fills in name + room ID
 *  "editor"   → full workspace is shown
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

import RoomJoin    from "./components/RoomJoin";
import Toolbar     from "./components/Toolbar";
import Sidebar     from "./components/Sidebar";
import Editor      from "./components/Editor";
import ChatPanel   from "./components/ChatPanel";
import OutputPanel from "./components/OutputPanel";

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

  // ── Collaboration ────────────────────────────────────────────────────────
  const {
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
    handleCodeChange,
    handleLanguageChange,
    handleCursorChange,
    emitLineAuthors,
    sendChatMessage,
    uploadFolder,
    switchFile,
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

  // Show toast on user join/leave
  useEffect(() => {
    if (!session) return;
    const joined = (user) => {
      if (user.id !== socket?.id) {
        toast.success(`${user.name} joined the room`, {
          icon: "👋",
          style: toastStyle,
        });
      }
    };
    const left = ({ userId }) => {
      const user = users.find((u) => u.id === userId);
      if (user) toast(`${user.name} left`, { icon: "👋", style: toastStyle });
    };
    socket?.on("user-joined", joined);
    socket?.on("user-left", left);
    return () => {
      socket?.off("user-joined", joined);
      socket?.off("user-left", left);
    };
  }, [socket, session, users]);

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
    // Update URL without reload so sharing works
    window.history.replaceState({}, "", `?room=${roomId}`);
  };

  const currentUser = users.find((u) => u.id === socket?.id);

  /**
   * Stable ref always holding the local user's author info.
   * Updated whenever the users list arrives from the server.
   * Using a ref (not state) so handleLinesEdited always has fresh data
   * without needing to be re-created on every render.
   */
  const localAuthorRef = useRef(null);
  useEffect(() => {
    const me = users.find((u) => u.id === socket?.id);
    if (me) {
      localAuthorRef.current = { name: me.name, color: me.color, userId: me.id };
    } else if (session) {
      // Fallback before server echoes the user list: use session name + accent colour.
      localAuthorRef.current = {
        name:   session.userName,
        color:  "#6366f1",
        userId: socket?.id || "local",
      };
    }
  }, [users, socket, session]);

  /**
   * Called by Editor when the local user touches specific line numbers.
   * Packages the author info and relays it via the socket.
   */
  const handleLinesEdited = (changedLines) => {
    // Initialise fallback immediately if ref isn't set yet
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
                onToggleTheme={() => setIsDark((d) => !d)}
                onLanguageChange={handleLanguageChange}
                onRun={handleRun}
                isRunning={isRunning}
              />

              {/* ── Main area ── */}
              <div className="flex flex-1 min-h-0">
                {/* Collaborator sidebar */}
                <Sidebar
                  users={users}
                  typingUsers={typingUsers}
                  currentUserId={socket?.id}
                  files={files}
                  activeFile={activeFile}
                  isUploading={isUploading}
                  onUploadFolder={uploadFolder}
                  onSelectFile={switchFile}
                />

                {/* Editor + output column */}
                <div className="flex flex-col flex-1 min-w-0">
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
