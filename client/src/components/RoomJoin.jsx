/**
 * RoomJoin – Landing screen where the user enters their name and room ID.
 * They can also generate a new random room ID via the server.
 *
 * Redesigned as a "terminal boot" card — the app's identity is a live,
 * shared console, so the entry point should feel like opening one.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { Zap, Users, TerminalSquare } from "lucide-react";
import axios from "axios";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const AUTHOR_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57", "#FF9FF3",
];

export default function RoomJoin({ onJoin, defaultRoom }) {
  const [roomId, setRoomId]     = useState(defaultRoom || "");
  const [userName, setUserName] = useState("");
  const [loading, setLoading]   = useState(false);

  const generateRoom = async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${SERVER_URL}/api/room/new`);
      setRoomId(data.roomId);
    } catch {
      // Fallback to client-side random if server is unreachable
      setRoomId(Math.random().toString(36).slice(2, 10));
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = (e) => {
    e.preventDefault();
    if (!roomId.trim() || !userName.trim()) return;
    onJoin({ roomId: roomId.trim(), userName: userName.trim() });
  };

  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        {/* Wordmark, styled like a terminal prompt */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 font-mono text-xs text-paper-muted mb-3">
            <TerminalSquare size={13} className="text-signal" />
            <span>pairs of developers, one live buffer</span>
          </div>
          <h1 className="font-mono text-3xl font-semibold text-paper tracking-tight">
            pair<span className="text-signal">editor</span>
            <span className="cursor-block ml-0.5" />
          </h1>
        </div>

        {/* Author-color divider — the signature motif, introduced early */}
        <div className="flex h-[3px] mb-8 rounded-full overflow-hidden">
          {AUTHOR_COLORS.map((c) => (
            <span key={c} className="flex-1" style={{ backgroundColor: c }} />
          ))}
        </div>

        {/* Form card, framed like a terminal window */}
        <div className="bg-panel border border-line rounded-lg overflow-hidden">
          {/* Fake window chrome */}
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-line bg-panel-raised">
            <span className="w-2.5 h-2.5 rounded-full bg-danger/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-warning/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-signal/70" />
            <span className="ml-2 font-mono text-[11px] text-paper-faint">~/join</span>
          </div>

          <form onSubmit={handleJoin} className="p-6 space-y-4">
            <div>
              <label className="flex items-center gap-1.5 font-mono text-[11px] text-paper-muted mb-2">
                <span className="text-signal">$</span> your_name
              </label>
              <input
                id="input-username"
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="alice"
                className="w-full px-3.5 py-2.5 rounded bg-panel-sunken border border-line text-paper placeholder-paper-faint font-mono text-sm focus:outline-none focus:border-signal/60 transition-colors"
                autoFocus
                maxLength={24}
              />
            </div>

            <div>
              <label className="flex items-center gap-1.5 font-mono text-[11px] text-paper-muted mb-2">
                <span className="text-signal">$</span> room_id
              </label>
              <div className="flex gap-2">
                <input
                  id="input-roomid"
                  type="text"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  placeholder="new or existing"
                  className="flex-1 px-3.5 py-2.5 rounded bg-panel-sunken border border-line text-paper placeholder-paper-faint focus:outline-none focus:border-signal/60 transition-colors font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={generateRoom}
                  disabled={loading}
                  id="btn-generate-room"
                  className="px-3.5 py-2.5 rounded bg-panel-raised border border-line text-paper-muted hover:text-paper hover:border-signal/40 transition-colors text-xs font-mono whitespace-nowrap"
                >
                  {loading ? "…" : "generate"}
                </button>
              </div>
            </div>

            <button
              type="submit"
              id="btn-join-room"
              disabled={!roomId.trim() || !userName.trim()}
              className="btn-signal w-full py-2.5 rounded bg-signal text-canvas font-semibold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed mt-2"
            >
              join room →
            </button>
          </form>
        </div>

        {/* Feature badges */}
        <div className="flex flex-wrap justify-center gap-2 mt-6">
          {[
            { icon: <Zap size={12} />, text: "real-time sync" },
            { icon: <Users size={12} />, text: "live line authorship" },
          ].map((f, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 font-mono text-[11px] px-2.5 py-1 rounded border border-line text-paper-muted"
            >
              <span className="text-signal">{f.icon}</span>
              {f.text}
            </span>
          ))}
        </div>

        <p className="text-center text-[11px] text-paper-faint mt-4">
          share the room id with collaborators to edit together.
        </p>
      </motion.div>
    </div>
  );
}
