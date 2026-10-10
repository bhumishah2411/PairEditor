/**
 * Sidebar – left panel:
 *   - Uploaded file tree on top
 *   - Team presence list below with personal/session indicators and collaborate/invite buttons
 */
import { motion, AnimatePresence } from "framer-motion";
import { UserPlus, Check, Users, LogOut, X } from "lucide-react";
import FileExplorer from "./FileExplorer";

export default function Sidebar({
  teamUsers = [],
  typingUsers,
  currentUserId,
  workspaceType = "personal",
  sessionId = null,
  outgoingRequests = new Set(),
  onSendCollabRequest,
  onCancelCollabRequest,
  onOpenLeaveModal,
  files,
  activeFile,
  isUploading,
  onUploadFolder,
  onCreateFile,
  onRenameFile,
  onDeleteFile,
  onSelectFile,
}) {
  return (
    <div className="w-64 shrink-0 flex flex-col bg-panel border-r border-line overflow-hidden">
      {/* Files section — flexible, takes remaining space */}
      <div className="flex-1 min-h-0 flex flex-col">
        <FileExplorer
          files={files}
          activeFile={activeFile}
          isUploading={isUploading}
          onUploadFolder={onUploadFolder}
          onCreateFile={onCreateFile}
          onRenameFile={onRenameFile}
          onDeleteFile={onDeleteFile}
          onSelectFile={onSelectFile}
        />
      </div>

      {/* Team presence & collaboration section */}
      <div className="shrink-0 max-h-[50%] flex flex-col border-t border-line">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
          <span className="font-mono text-[11px] text-paper-faint">$ team members</span>
          <span className="ml-auto font-mono text-[11px] font-semibold text-signal bg-signal/10 px-2 py-0.5 rounded">
            {teamUsers.length}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          <AnimatePresence>
            {teamUsers.map((user) => {
              const isTyping   = typingUsers?.has(user.id);
              const isMe       = user.id === currentUserId;
              const inMySession =
                workspaceType === "session" &&
                sessionId &&
                user.sessionId === sessionId;
              const isPending  = outgoingRequests?.has(user.id);

              return (
                <motion.div
                  key={user.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-2.5 px-2.5 py-2 rounded border-l-2 bg-panel-raised/30 hover:bg-panel-raised/70 transition-colors"
                  style={{ borderColor: user.color }}
                >
                  {/* Square block avatar with user color */}
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center text-[11px] font-mono font-bold shrink-0"
                    style={{ backgroundColor: user.color + "22", color: user.color }}
                  >
                    {user.name.charAt(0).toUpperCase()}
                  </div>

                  {/* Name + Status */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-paper font-medium truncate max-w-[80px]">
                        {user.name}
                      </span>
                      {isMe ? (
                        <span className="font-mono text-[10px] text-paper-faint">you</span>
                      ) : (
                        <span
                          className={`font-mono text-[9px] px-1 py-0.2 rounded border ${
                            user.workspaceType === "session"
                              ? "bg-signal/10 text-signal border-signal/20"
                              : "bg-panel-raised text-paper-muted border-line"
                          }`}
                        >
                          {user.workspaceType === "session" ? "in session" : "solo"}
                        </span>
                      )}
                    </div>

                    {isTyping && (
                      <div className="flex items-center gap-0.5 mt-0.5">
                        <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        <span className="font-mono text-[9px] text-paper-faint ml-1">typing</span>
                      </div>
                    )}
                  </div>

                  {/* Collaboration action button */}
                  <div className="shrink-0">
                    {isMe ? (
                      workspaceType === "session" ? (
                        <button
                          onClick={onOpenLeaveModal}
                          id="btn-sidebar-leave-session"
                          className="flex items-center gap-1 font-mono text-[10px] text-danger hover:bg-danger/20 bg-danger/10 px-2 py-0.5 rounded border border-danger/30 transition-colors font-semibold"
                          title="Leave this session and work separately"
                        >
                          <LogOut size={10} />
                          <span>leave</span>
                        </button>
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-signal inline-block" />
                      )
                    ) : inMySession ? (
                      <span
                        className="inline-flex items-center gap-1 font-mono text-[10px] text-signal font-medium bg-signal/10 px-1.5 py-0.5 rounded border border-signal/20"
                        title="Already collaborating in your session"
                      >
                        <Check size={10} />
                        <span>synced</span>
                      </span>
                    ) : isPending ? (
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-[10px] text-paper-faint bg-panel-raised px-1.5 py-0.5 rounded border border-line">
                          sent…
                        </span>
                        {onCancelCollabRequest && (
                          <button
                            onClick={() => onCancelCollabRequest(user.id)}
                            className="w-4 h-4 flex items-center justify-center rounded hover:bg-danger/20 text-paper-faint hover:text-danger transition-colors"
                            title="Cancel collaboration request"
                          >
                            <X size={10} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => onSendCollabRequest(user.id)}
                        className="btn-signal flex items-center gap-1 px-2 py-0.5 rounded bg-signal/15 hover:bg-signal text-signal hover:text-canvas text-[10px] font-mono font-medium transition-all border border-signal/30"
                        title={
                          workspaceType === "session"
                            ? `Invite ${user.name} to this session`
                            : `Request to collaborate with ${user.name}`
                        }
                      >
                        {workspaceType === "session" ? (
                          <>
                            <UserPlus size={10} />
                            <span>invite</span>
                          </>
                        ) : (
                          <>
                            <Users size={10} />
                            <span>collab</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
