/**
 * Sidebar – left panel: uploaded file tree on top, active collaborators below.
 */
import { motion, AnimatePresence } from "framer-motion";
import FileExplorer from "./FileExplorer";

export default function Sidebar({
  users,
  typingUsers,
  currentUserId,
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
    <div className="w-60 shrink-0 flex flex-col bg-panel border-r border-line overflow-hidden">
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

      {/* Collaborators section — capped height, own scroll */}
      <div className="shrink-0 max-h-[45%] flex flex-col border-t border-line">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
          <span className="font-mono text-[11px] text-paper-faint">$ who</span>
          <span className="ml-auto font-mono text-[11px] font-semibold text-signal bg-signal/10 px-2 py-0.5 rounded">
            {users.length}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <AnimatePresence>
            {users.map((user) => {
              const isTyping = typingUsers.has(user.id);
              const isMe     = user.id === currentUserId;

              return (
                <motion.div
                  key={user.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-3 pl-3 pr-3 py-2.5 rounded border-l-2 hover:bg-panel-raised/70 transition-colors"
                  style={{ borderColor: user.color }}
                >
                  {/* Square block avatar — echoes the author-gutter motif */}
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center text-[11px] font-mono font-bold shrink-0"
                    style={{ backgroundColor: user.color + "22", color: user.color }}
                  >
                    {user.name.charAt(0).toUpperCase()}
                  </div>

                  {/* Name + status */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-paper font-medium truncate">
                        {user.name}
                      </span>
                      {isMe && (
                        <span className="font-mono text-[10px] text-paper-faint">you</span>
                      )}
                    </div>
                    {isTyping && (
                      <div className="flex items-center gap-0.5 mt-0.5">
                        <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        <span className="font-mono text-[10px] text-paper-faint ml-1">typing</span>
                      </div>
                    )}
                  </div>

                  {/* Online indicator */}
                  <span className="w-1.5 h-1.5 rounded-full bg-signal shrink-0" />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
