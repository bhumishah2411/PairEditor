/**
 * VoiceCallDock – Floating interactive control dock for active WebRTC voice call.
 * Features:
 *   - Participant avatars with active speaking animations (green pulsing ring)
 *   - Mute & Deafen toggle buttons with visual indicators
 *   - Quick disconnect button
 *   - Minimizable / collapsible dock
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  PhoneOff,
  ChevronDown,
  ChevronUp,
  Radio,
  Users,
} from "lucide-react";

export default function VoiceCallDock({
  isInCall,
  isConnecting,
  isMuted,
  isDeafened,
  participants = [],
  currentUser,
  onToggleMute,
  onToggleDeafen,
  onLeaveCall,
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (!isInCall && !isConnecting) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      className="fixed bottom-5 left-5 z-40 flex flex-col font-mono"
    >
      <div className="bg-panel/95 backdrop-blur-md border border-line/80 rounded-2xl shadow-2xl p-3 flex flex-col gap-2.5 min-w-[280px] max-w-[340px]">
        {/* Header Bar */}
        <div className="flex items-center justify-between border-b border-line/50 pb-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-signal opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-signal" />
            </span>
            <span className="text-xs font-semibold text-paper flex items-center gap-1.5">
              Voice Room
              <span className="text-[10px] text-paper-faint font-normal">
                ({participants.length} {participants.length === 1 ? "peer" : "peers"})
              </span>
            </span>
          </div>

          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="text-paper-faint hover:text-paper p-1 rounded hover:bg-panel transition-colors"
            title={collapsed ? "Expand voice dock" : "Minimize voice dock"}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {/* Collapsible Participants List */}
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="space-y-1.5 overflow-hidden"
            >
              <div className="flex flex-wrap gap-2 py-1 max-h-36 overflow-y-auto">
                {participants.map((p) => {
                  const isMe = p.id === currentUser?.id;
                  const isSpeaking = p.speaking;
                  const isUserMuted = isMe ? isMuted : p.muted;

                  return (
                    <div
                      key={p.id}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl border transition-all text-xs ${
                        isSpeaking
                          ? "bg-signal/15 border-signal text-paper shadow-[0_0_12px_rgba(111,227,166,0.25)]"
                          : "bg-panel-sunken border-line/60 text-paper-muted"
                      }`}
                    >
                      {/* Avatar with speaking wave ring */}
                      <div className="relative">
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px] text-canvas transition-all ${
                            isSpeaking ? "ring-2 ring-signal ring-offset-1 ring-offset-panel" : ""
                          }`}
                          style={{ backgroundColor: p.color || "#6FE3A6" }}
                        >
                          {p.name ? p.name[0].toUpperCase() : "U"}
                        </div>
                        {isUserMuted && (
                          <div className="absolute -bottom-1 -right-1 bg-red-500 rounded-full p-0.5 text-white">
                            <MicOff size={8} />
                          </div>
                        )}
                      </div>

                      <span className="font-medium truncate max-w-[90px]">
                        {isMe ? "You" : p.name}
                      </span>

                      {isSpeaking && (
                        <Radio size={11} className="text-signal animate-pulse" />
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Controls Bar */}
        <div className="flex items-center justify-between pt-1 gap-2">
          {/* Mute button */}
          <button
            type="button"
            onClick={onToggleMute}
            className={`flex-1 py-1.5 px-2 rounded-xl flex items-center justify-center gap-1.5 text-xs font-semibold transition-all border ${
              isMuted
                ? "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25"
                : "bg-panel-raised border-line text-paper-muted hover:text-paper hover:border-signal/40"
            }`}
            title={isMuted ? "Unmute microphone" : "Mute microphone"}
          >
            {isMuted ? <MicOff size={14} /> : <Mic size={14} className="text-signal" />}
            <span>{isMuted ? "Muted" : "Mute"}</span>
          </button>

          {/* Deafen button */}
          <button
            type="button"
            onClick={onToggleDeafen}
            className={`py-1.5 px-2.5 rounded-xl flex items-center justify-center transition-all border ${
              isDeafened
                ? "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25"
                : "bg-panel-raised border-line text-paper-muted hover:text-paper hover:border-signal/40"
            }`}
            title={isDeafened ? "Undeafen (unmute sound)" : "Deafen (mute sound)"}
          >
            {isDeafened ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>

          {/* Leave Call button */}
          <button
            type="button"
            onClick={onLeaveCall}
            className="py-1.5 px-3 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-400 hover:text-red-300 flex items-center justify-center gap-1 text-xs font-semibold transition-all"
            title="Disconnect from voice call"
          >
            <PhoneOff size={13} />
            <span>Leave</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
