/**
 * LeaveConfirmModal – confirmation dialog when a user wants to leave a session.
 * Informs the user that their private workspace will retain a full copy of the session's work.
 */
import { motion, AnimatePresence } from "framer-motion";
import { LogOut, X, AlertTriangle } from "lucide-react";

export default function LeaveConfirmModal({ isOpen, onClose, onConfirm, isLeaving }) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ type: "spring", stiffness: 350, damping: 28 }}
          className="w-full max-w-md bg-panel border border-line rounded-lg shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-panel-raised">
            <div className="flex items-center gap-2">
              <LogOut size={15} className="text-danger" />
              <span className="font-mono text-xs font-semibold text-paper">
                Leave Session
              </span>
            </div>
            <button
              onClick={onClose}
              disabled={isLeaving}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-panel text-paper-muted hover:text-paper transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          {/* Body */}
          <div className="p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-md bg-danger/10 border border-danger/20 flex items-center justify-center text-danger shrink-0 mt-0.5">
                <AlertTriangle size={16} />
              </div>
              <div className="space-y-1">
                <p className="text-sm text-paper font-medium">
                  Leave this session and work separately?
                </p>
                <p className="text-xs text-paper-muted leading-relaxed">
                  You will keep a copy of the current code, files and whiteboard in your private workspace.
                  Remaining members will continue collaborating in the session.
                </p>
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-line bg-panel-sunken/40">
            <button
              type="button"
              onClick={onClose}
              disabled={isLeaving}
              className="px-3.5 py-1.5 rounded font-mono text-xs text-paper-muted hover:text-paper hover:bg-panel-raised border border-line transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              id="btn-confirm-leave-session"
              onClick={onConfirm}
              disabled={isLeaving}
              className="btn-signal flex items-center gap-1.5 px-4 py-1.5 rounded bg-danger hover:bg-danger/90 text-white font-mono text-xs font-semibold shadow-md transition-all disabled:opacity-50"
            >
              <LogOut size={13} />
              <span>{isLeaving ? "Leaving…" : "Leave"}</span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
