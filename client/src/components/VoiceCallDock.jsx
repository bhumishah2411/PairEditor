/**
 * VoiceCallDock – Floating interactive control dock for WebRTC voice & video calls.
 * Features:
 *   - Live local video preview & remote participant video tiles
 *   - Real-time speaking indicators & volume wave animations
 *   - Camera toggle (On/Off) with visual preview
 *   - Microphone toggle (Mute/Unmute)
 *   - Deafen toggle (Mute incoming sounds)
 *   - Clean layout: expands into sleek video grid when video is active,
 *     collapses into compact pill to preserve code editor space.
 *   - 100% responsive and dark/light theme compatible.
 */
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  PhoneOff,
  ChevronDown,
  ChevronUp,
  Radio,
  Users,
  Maximize2,
  Minimize2,
} from "lucide-react";

/**
 * Individual participant video tile with camera fallback avatar.
 */
function VideoTile({
  stream,
  isMirrored = false,
  name,
  color,
  isSpeaking,
  isUserMuted,
  isVideoOff,
  isLocal,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (stream && videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }
  }, [stream]);

  const hasVideoTrack =
    stream &&
    stream.getVideoTracks().some(
      (t) => t.readyState === "live" && t.enabled
    );
  const showVideo = !isVideoOff && hasVideoTrack;

  return (
    <div
      className={`relative rounded-xl overflow-hidden bg-panel-sunken border aspect-video flex items-center justify-center transition-all ${
        isSpeaking
          ? "border-signal ring-2 ring-signal/50 shadow-md shadow-signal/20"
          : "border-line/70"
      }`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${
            isMirrored ? "scale-x-[-1]" : ""
          }`}
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-1.5 p-3 text-center select-none">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm text-canvas shadow transition-all ${
              isSpeaking
                ? "ring-2 ring-signal ring-offset-2 ring-offset-panel"
                : ""
            }`}
            style={{ backgroundColor: color || "#6FE3A6" }}
          >
            {name ? name[0].toUpperCase() : "U"}
          </div>
          <span className="text-[10px] text-paper-faint font-mono">
            Camera off
          </span>
        </div>
      )}

      {/* Floating Badges */}
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between pointer-events-none">
        <div className="bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded-md text-[10px] font-mono text-white flex items-center gap-1 max-w-[130px] truncate shadow">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color || "#6FE3A6" }}
          />
          <span className="truncate">{name}</span>
          {isLocal && <span className="text-white/60 text-[9px]">(You)</span>}
        </div>

        <div className="flex items-center gap-1">
          {isUserMuted && (
            <div
              className="bg-red-500/90 p-1 rounded-md text-white shadow"
              title="Muted"
            >
              <MicOff size={10} />
            </div>
          )}
          {isSpeaking && (
            <div
              className="bg-signal/90 p-1 rounded-md text-canvas shadow animate-pulse"
              title="Speaking"
            >
              <Radio size={10} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VoiceCallDock({
  isInCall,
  isConnecting,
  isMuted,
  isDeafened,
  isVideoEnabled = false,
  callMode = "voice",
  participants = [],
  currentUser,
  localStream,
  remoteStreams = new Map(),
  onToggleMute,
  onToggleDeafen,
  onToggleVideo,
  onLeaveCall,
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (!isInCall && !isConnecting) return null;

  // Determine if anyone has video active
  const hasAnyVideo =
    isVideoEnabled ||
    participants.some((p) => p.video) ||
    callMode === "video";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      className="fixed bottom-5 left-5 z-40 flex flex-col font-mono"
    >
      <div
        className={`bg-panel/95 backdrop-blur-md border border-line/80 rounded-2xl shadow-2xl p-3 flex flex-col gap-2.5 transition-all ${
          collapsed
            ? "min-w-[280px] max-w-[320px]"
            : hasAnyVideo
            ? "min-w-[320px] max-w-[460px] w-full"
            : "min-w-[280px] max-w-[340px]"
        }`}
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between border-b border-line/50 pb-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-signal opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-signal" />
            </span>
            <span className="text-xs font-semibold text-paper flex items-center gap-1.5">
              {hasAnyVideo ? "Video Call" : "Voice Room"}
              <span className="text-[10px] text-paper-faint font-normal">
                ({participants.length}{" "}
                {participants.length === 1 ? "participant" : "participants"})
              </span>
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              id="btn-dock-collapse"
              onClick={() => setCollapsed(!collapsed)}
              className="text-paper-faint hover:text-paper p-1 rounded hover:bg-panel transition-colors"
              title={collapsed ? "Expand call dock" : "Minimize call dock"}
            >
              {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {/* Collapsible Content */}
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="space-y-2 overflow-hidden"
            >
              {/* If Video Mode: Render Video Grid */}
              {hasAnyVideo ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[360px] overflow-y-auto py-1 pr-0.5">
                  {/* Local participant video preview */}
                  <VideoTile
                    stream={localStream}
                    isMirrored={true}
                    name="You"
                    color={currentUser?.color || "#6FE3A6"}
                    isSpeaking={currentUser?.speaking}
                    isUserMuted={isMuted}
                    isVideoOff={!isVideoEnabled}
                    isLocal={true}
                  />

                  {/* Remote participants video tiles */}
                  {participants
                    .filter((p) => p.id !== currentUser?.id)
                    .map((p) => {
                      const stream = remoteStreams.get(p.id);
                      return (
                        <VideoTile
                          key={p.id}
                          stream={stream}
                          isMirrored={false}
                          name={p.name}
                          color={p.color}
                          isSpeaking={p.speaking}
                          isUserMuted={p.muted}
                          isVideoOff={!p.video}
                          isLocal={false}
                        />
                      );
                    })}
                </div>
              ) : (
                /* Voice-only Mode: Sleek Participant Avatars with Speaking rings */
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
                              isSpeaking
                                ? "ring-2 ring-signal ring-offset-1 ring-offset-panel"
                                : ""
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
                          <Radio
                            size={11}
                            className="text-signal animate-pulse"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Controls Bar */}
        <div className="flex items-center justify-between pt-1 gap-1.5">
          {/* Mute button */}
          <button
            type="button"
            id="btn-dock-mute"
            onClick={onToggleMute}
            className={`flex-1 py-1.5 px-2 rounded-xl flex items-center justify-center gap-1.5 text-xs font-semibold transition-all border ${
              isMuted
                ? "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25"
                : "bg-panel-raised border-line text-paper-muted hover:text-paper hover:border-signal/40"
            }`}
            title={isMuted ? "Unmute microphone" : "Mute microphone"}
          >
            {isMuted ? (
              <MicOff size={14} />
            ) : (
              <Mic size={14} className="text-signal" />
            )}
            <span className="hidden sm:inline">
              {isMuted ? "Muted" : "Mute"}
            </span>
          </button>

          {/* Camera toggle button */}
          <button
            type="button"
            id="btn-dock-video"
            onClick={onToggleVideo}
            className={`flex-1 py-1.5 px-2 rounded-xl flex items-center justify-center gap-1.5 text-xs font-semibold transition-all border ${
              !isVideoEnabled
                ? "bg-panel-raised border-line text-paper-muted hover:text-paper hover:border-signal/40"
                : "bg-signal/15 border-signal/40 text-signal shadow-[0_0_10px_rgba(111,227,166,0.15)] hover:bg-signal/25"
            }`}
            title={isVideoEnabled ? "Turn camera off" : "Turn camera on"}
          >
            {isVideoEnabled ? (
              <Video size={14} className="text-signal" />
            ) : (
              <VideoOff size={14} />
            )}
            <span className="hidden sm:inline">
              {isVideoEnabled ? "Cam On" : "Cam Off"}
            </span>
          </button>

          {/* Deafen button */}
          <button
            type="button"
            id="btn-dock-deafen"
            onClick={onToggleDeafen}
            className={`py-1.5 px-2.5 rounded-xl flex items-center justify-center transition-all border ${
              isDeafened
                ? "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25"
                : "bg-panel-raised border-line text-paper-muted hover:text-paper hover:border-signal/40"
            }`}
            title={
              isDeafened
                ? "Undeafen (unmute sound)"
                : "Deafen (mute sound)"
            }
          >
            {isDeafened ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>

          {/* Leave Call button */}
          <button
            type="button"
            id="btn-dock-leave"
            onClick={onLeaveCall}
            className="py-1.5 px-3 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-400 hover:text-red-300 flex items-center justify-center gap-1 text-xs font-semibold transition-all"
            title="Disconnect from call"
          >
            <PhoneOff size={13} />
            <span>Leave</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
