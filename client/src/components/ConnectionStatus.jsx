/**
 * ConnectionStatus – small pill in the top-right showing socket health.
 * Pulses green when connected, amber when reconnecting, red when disconnected.
 */
import { motion, AnimatePresence } from "framer-motion";
import { Wifi, WifiOff } from "lucide-react";

export default function ConnectionStatus({ connected }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={connected ? "online" : "offline"}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ duration: 0.2 }}
        className={`hidden md:flex items-center gap-1.5 font-mono text-[11px] font-medium px-2.5 py-1.5 rounded border ${
          connected
            ? "bg-signal/10 border-signal/25 text-signal"
            : "bg-danger/10 border-danger/25 text-danger"
        }`}
      >
        {/* Pulsing dot */}
        <span className="relative flex h-1.5 w-1.5">
          {connected && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-signal opacity-75" />
          )}
          <span
            className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
              connected ? "bg-signal" : "bg-danger"
            }`}
          />
        </span>
        {connected ? (
          <><Wifi size={11} /> connected</>
        ) : (
          <><WifiOff size={11} /> offline</>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
