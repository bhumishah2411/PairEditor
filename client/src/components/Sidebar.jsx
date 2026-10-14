import { useState } from "react";
import { Users, Activity } from "lucide-react";
import FileExplorer from "./FileExplorer";

function formatActivityTime(timestamp) {
  if (!timestamp) return "";
  const sec = Math.floor((Date.now() - timestamp) / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export default function Sidebar({
  teamUsers = [],
  typingUsers,
  currentUserId,
  activities = [],
  files,
  activeFile,
  isUploading,
  onUploadFolder,
  onCreateFile,
  onRenameFile,
  onDeleteFile,
  onSelectFile,
  onOpenGitHubModal,
}) {
  const [activeTab, setActiveTab] = useState("team"); // "team" | "activity"

  return (
    <div className="w-64 shrink-0 flex flex-col bg-panel border-r border-line overflow-hidden">
      {/* Files section */}
      <div className="flex-1 min-h-0 flex flex-col">
        <FileExplorer
          files={files}
          activeFile={activeFile}
          currentUserId={currentUserId}
          isUploading={isUploading}
          onUploadFolder={onUploadFolder}
          onCreateFile={onCreateFile}
          onRenameFile={onRenameFile}
          onDeleteFile={onDeleteFile}
          onSelectFile={onSelectFile}
          onOpenGitHubModal={onOpenGitHubModal}
        />
      </div>

      {/* Bottom section: Team Members & Activity Feed */}
      <div className="shrink-0 h-64 flex flex-col border-t border-line bg-panel-sunken/30">
        {/* Tab switch header */}
        <div className="flex items-center px-2 py-2 border-b border-line shrink-0 gap-1 bg-panel">
          <button
            onClick={() => setActiveTab("team")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
              activeTab === "team"
                ? "bg-panel-raised text-signal font-semibold border border-line"
                : "text-paper-muted hover:text-paper"
            }`}
          >
            <Users size={12} />
            <span>members</span>
            <span className="text-[10px] bg-panel px-1 py-0.2 rounded text-paper-faint">
              {teamUsers.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab("activity")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
              activeTab === "activity"
                ? "bg-panel-raised text-signal font-semibold border border-line"
                : "text-paper-muted hover:text-paper"
            }`}
          >
            <Activity size={12} />
            <span>activity</span>
            {activities.length > 0 && (
              <span className="text-[10px] bg-panel px-1 py-0.2 rounded text-paper-faint">
                {activities.length > 50 ? "50+" : activities.length}
              </span>
            )}
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-2">
          {activeTab === "team" ? (
            <div className="space-y-1">
              {teamUsers.map((user) => {
                const isTyping = typingUsers?.has(user.id);
                const isMe = user.id === currentUserId;

                return (
                  <div
                    key={user.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-panel-raised/50 transition-colors"
                  >
                    {/* Avatar */}
                    <div
                      className="w-5.5 h-5.5 rounded flex items-center justify-center text-[10px] font-mono font-bold shrink-0"
                      style={{ backgroundColor: user.color + "22", color: user.color }}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </div>

                    {/* Name */}
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                      <span className="text-xs text-paper font-medium truncate">
                        {user.name}
                      </span>
                      {isMe && (
                        <span className="font-mono text-[9px] text-paper-faint px-1 rounded bg-panel-raised">
                          you
                        </span>
                      )}
                      {isTyping && (
                        <div className="flex items-center gap-0.5 ml-auto">
                          <span className="typing-dot" style={{ backgroundColor: user.color }} />
                          <span className="typing-dot" style={{ backgroundColor: user.color }} />
                          <span className="typing-dot" style={{ backgroundColor: user.color }} />
                        </div>
                      )}
                    </div>

                    {/* Online dot */}
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Online" />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-1.5">
              {activities.length === 0 ? (
                <div className="text-center py-6 text-paper-faint text-xs font-mono">
                  No recent activity
                </div>
              ) : (
                activities.slice(0, 50).map((act) => (
                  <div
                    key={act.id}
                    className="flex items-start gap-1.5 text-[11px] font-mono text-paper-muted leading-tight py-1 px-1.5 rounded hover:bg-panel-raised/40 transition-colors"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0 mt-1"
                      style={{ backgroundColor: act.color || "#6FE3A6" }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-paper">{act.text}</span>
                    </div>
                    <span className="text-[9px] text-paper-faint shrink-0 ml-1">
                      {formatActivityTime(act.timestamp)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
