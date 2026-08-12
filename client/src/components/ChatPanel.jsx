/**
 * ChatPanel – right-side slide-in chat panel.
 * Messages are stored in component state + socket relay (server broadcasts them).
 * Bubble-style layout, restyled to the app's terminal-inspired palette:
 * sender name in their author color, outlined bubbles for others,
 * filled signal-green bubble for the local user.
 */
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X } from "lucide-react";

export default function ChatPanel({ messages, onSend, onClose, currentUser }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);

  // Auto-scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput("");
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
            No messages yet. Say hi! 👋
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
                  {msg.message}
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

      {/* Input */}
      <form onSubmit={handleSend} className="p-3 border-t border-line">
        <div className="flex gap-2">
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
            type="submit"
            id="btn-send-chat"
            disabled={!input.trim()}
            className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full bg-signal text-canvas transition-all disabled:opacity-30"
          >
            <Send size={15} />
          </button>
        </div>
      </form>
    </motion.div>
  );
}
