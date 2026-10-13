/**
 * ChatPanel – right-side slide-in chat panel.
 * Supports:
 *   - Real-time text messaging
 *   - Voice recording & audio note playback (via standard MediaRecorder + DataURL)
 * Bubble-style layout, styled to the terminal-inspired palette.
 */
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X, Mic, Play, Pause, Trash2 } from "lucide-react";
import toast from "react-hot-toast";

/**
 * Inline Voice Note Player component with animated sound wave bars.
 */
function VoiceMessage({ audioUrl, duration, isMe }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef(null);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((err) => {
        console.warn("Audio playback error:", err);
      });
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const formatSecs = (secs) => {
    const s = Math.floor(secs || 0);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? "0" : ""}${rem}`;
  };

  return (
    <div className="flex items-center gap-2.5 py-1 min-w-[160px]">
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
      />
      <button
        type="button"
        onClick={togglePlay}
        title={isPlaying ? "Pause" : "Play voice message"}
        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-transform active:scale-95 ${
          isMe
            ? "bg-canvas text-signal hover:bg-canvas/90"
            : "bg-signal text-canvas hover:bg-signal/90"
        }`}
      >
        {isPlaying ? (
          <Pause size={12} fill="currentColor" />
        ) : (
          <Play size={12} fill="currentColor" className="ml-0.5" />
        )}
      </button>

      {/* Waveform Visualization Bars */}
      <div className="flex-1 flex flex-col justify-center">
        <div className="flex items-center gap-0.5 h-4">
          {[35, 65, 45, 95, 75, 50, 85, 40, 70, 90, 60, 40, 80, 50].map((h, i) => (
            <span
              key={i}
              className={`w-1 rounded-full transition-all duration-150 ${
                isPlaying
                  ? "bg-current animate-pulse opacity-90"
                  : isMe
                  ? "bg-canvas/50"
                  : "bg-paper-muted/40"
              }`}
              style={{
                height: isPlaying ? `${Math.max(25, (h + (i % 3) * 15) % 100)}%` : `${h}%`,
              }}
            />
          ))}
        </div>
        <div className="flex justify-between items-center text-[9px] font-mono mt-1 opacity-80">
          <span>{isPlaying ? formatSecs(currentTime) : (duration || "Voice Note")}</span>
          <span className="text-[8px] uppercase tracking-wider font-semibold">Voice</span>
        </div>
      </div>
    </div>
  );
}

export default function ChatPanel({ messages, onSend, onClose, currentUser }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);

  // Voice Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  // Auto-scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Clean up any active microphone recording stream on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const handleSend = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput("");
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  // ── Start Audio Recording ───────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast.error("Audio recording is not supported in this browser.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      let mimeType = "";
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("audio/webm")) {
          mimeType = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          mimeType = "audio/mp4";
        } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
          mimeType = "audio/ogg";
        }
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.start(100);
      setIsRecording(true);
      setRecordingSeconds(0);

      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Microphone access error:", err);
      toast.error("Microphone permission denied or unavailable.");
    }
  };

  // ── Cancel Audio Recording ──────────────────────────────────────────────────
  const cancelRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingSeconds(0);
  };

  // ── Stop & Send Voice Note ──────────────────────────────────────────────────
  const stopAndSendRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    const recordedDuration = formatDuration(recordingSeconds || 1);

    recorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });

      if (blob.size === 0) {
        cancelRecording();
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const audioUrl = reader.result;
        onSend({
          message: "🎤 Voice message",
          audioUrl,
          duration: recordedDuration,
        });
      };
      reader.readAsDataURL(blob);

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };

    recorder.stop();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    setRecordingSeconds(0);
  };

  return (
    <motion.div
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="w-72 shrink-0 flex flex-col bg-panel border-l border-line"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-semibold text-paper">Chat</span>
        <button
          id="btn-close-chat"
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-panel-raised text-paper-muted hover:text-paper transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3.5">
        {messages.length === 0 && (
          <p className="text-xs text-paper-faint text-center mt-8">
            No messages yet. Say hi or send a voice note! 👋
          </p>
        )}
        <AnimatePresence initial={false}>
          {messages.map((msg) => {
            const isMe = msg.userId === currentUser?.id;
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
              >
                {/* Sender name — colored with their author color */}
                <span
                  className="font-mono text-[10px] font-semibold mb-1"
                  style={{ color: isMe ? "#6FE3A6" : msg.color }}
                >
                  {isMe ? "You" : msg.userName}
                </span>

                {/* Bubble */}
                <div
                  className={`max-w-[85%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                    isMe
                      ? "bg-signal text-canvas font-medium rounded-br-md"
                      : "bg-transparent text-paper border-[1.5px] rounded-bl-md"
                  }`}
                  style={!isMe ? { borderColor: msg.color } : undefined}
                >
                  {msg.audioUrl ? (
                    <VoiceMessage
                      audioUrl={msg.audioUrl}
                      duration={msg.duration}
                      isMe={isMe}
                    />
                  ) : (
                    msg.message
                  )}
                </div>
                <span className="text-[10px] text-paper-faint mt-1">
                  {formatTime(msg.timestamp)}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>

      {/* Input or Voice Recording Bar */}
      <div className="p-3 border-t border-line">
        {isRecording ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-full bg-panel-raised border border-signal/40 shadow-sm animate-pulse">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
              <span className="text-xs font-mono font-semibold text-paper">
                {formatDuration(recordingSeconds)}
              </span>
              <span className="text-[11px] font-mono text-paper-muted">Recording…</span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={cancelRecording}
                title="Discard voice recording"
                className="w-7 h-7 rounded-full flex items-center justify-center text-paper-faint hover:text-red-400 hover:bg-panel transition-colors"
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                onClick={stopAndSendRecording}
                title="Send voice message"
                className="w-7 h-7 rounded-full flex items-center justify-center bg-signal text-canvas hover:scale-105 transition-all shadow-sm"
              >
                <Send size={12} />
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSend} className="flex gap-2 items-center">
            <input
              id="chat-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message…"
              className="flex-1 px-3.5 py-2.5 rounded-full bg-panel-sunken border border-line text-sm text-paper placeholder-paper-faint focus:outline-none focus:border-signal/50 transition-colors"
              maxLength={500}
            />
            <button
              type="button"
              id="btn-voice-record"
              onClick={startRecording}
              title="Record voice message"
              className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full bg-panel-raised border border-line text-paper-muted hover:text-signal hover:border-signal/40 transition-colors"
            >
              <Mic size={15} />
            </button>
            <button
              type="submit"
              id="btn-send-chat"
              disabled={!input.trim()}
              className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full bg-signal text-canvas transition-all disabled:opacity-30"
            >
              <Send size={15} />
            </button>
          </form>
        )}
      </div>
    </motion.div>
  );
}
