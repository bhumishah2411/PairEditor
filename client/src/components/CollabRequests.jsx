/**
 * CollabRequests – floating stacked notification popups for incoming collaboration invitations.
 */
import { motion, AnimatePresence } from "framer-motion";
import { Users, Check, X } from "lucide-react";

export default function CollabRequests({ requests = [], onRespond }) {
  if (!requests.length) return null;

  return (
    <div className="fixed top-14 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      <AnimatePresence>
        {requests.map((req) => (
          <motion.div
            key={req.fromUserId}
            initial={{ opacity: 0, y: -16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 350, damping: 28 }}
            className="pointer-events-auto bg-panel/95 backdrop-blur-md border border-line p-3.5 rounded-lg shadow-2xl flex flex-col gap-2.5"
            style={{ borderLeftColor: req.fromColor, borderLeftWidth: 3 }}
          >
            <div className="flex items-start gap-2.5">
              <div
                className="w-7 h-7 rounded flex items-center justify-center font-mono font-bold text-xs shrink-0"
                style={{
                  backgroundColor: (req.fromColor || "#6FE3A6") + "22",
                  color: req.fromColor || "#6FE3A6",
                }}
              >
                {req.fromName?.charAt(0).toUpperCase() || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-xs text-paper truncate">
                    {req.fromName}
                  </span>
                  <span className="font-mono text-[10px] text-paper-faint">
                    wants to collaborate
                  </span>
                </div>
                <p className="text-[11px] text-paper-muted mt-0.5 leading-snug">
                  Join a shared session to code, draw, and chat together.
                </p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1 border-t border-line/50">
              <button
                onClick={() => onRespond(req.fromUserId, false)}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-panel-raised hover:bg-danger/10 hover:text-danger text-paper-muted border border-line text-xs font-mono transition-colors"
              >
                <X size={12} />
                <span>decline</span>
              </button>
              <button
                onClick={() => onRespond(req.fromUserId, true)}
                className="btn-signal flex items-center gap-1 px-3 py-1 rounded bg-signal text-canvas font-semibold text-xs font-mono shadow-sm transition-all"
              >
                <Check size={12} />
                <span>accept</span>
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
