/**
 * OutputPanel – bottom panel showing code execution results.
 * Displays stdout, stderr, compile errors, and execution metadata.
 */
import { motion } from "framer-motion";
import { X, Terminal, Clock, CpuIcon } from "lucide-react";

export default function OutputPanel({ result, isRunning, onClose }) {
  const hasError = result?.stderr || result?.compile_output;
  const statusOk = result?.status === "Accepted";

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 220, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="shrink-0 border-t border-line bg-canvas overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-panel shrink-0">
        <div className="flex items-center gap-2">
          <Terminal size={13} className="text-signal" />
          <span className="font-mono text-[11px] text-paper-muted">output</span>
          {result && (
            <span
              className={`font-mono text-[10px] px-2 py-0.5 rounded font-medium ${
                statusOk
                  ? "bg-signal/15 text-signal"
                  : "bg-danger/15 text-danger"
              }`}
            >
              {result.status}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {result?.time && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-paper-faint">
              <Clock size={10} /> {result.time}s
            </span>
          )}
          {result?.memory && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-paper-faint">
              <CpuIcon size={10} /> {(result.memory / 1024).toFixed(1)} MB
            </span>
          )}
          <button
            id="btn-close-output"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-panel-raised text-paper-faint hover:text-paper transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Output body */}
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
        {isRunning ? (
          <span className="text-paper-muted animate-pulse">executing…</span>
        ) : result ? (
          <>
            {result.compile_output && (
              <div className="text-warning mb-2 whitespace-pre-wrap">
                <span className="text-paper-faint">// compile output</span>{"\n"}
                {result.compile_output}
              </div>
            )}
            {result.stderr && (
              <div className="text-danger whitespace-pre-wrap">
                <span className="text-paper-faint">// stderr</span>{"\n"}
                {result.stderr}
              </div>
            )}
            {result.stdout && (
              <div className="text-signal whitespace-pre-wrap">
                {result.stdout}
              </div>
            )}
            {!result.stdout && !result.stderr && !result.compile_output && (
              <span className="text-paper-faint">(no output)</span>
            )}
          </>
        ) : (
          <span className="text-paper-faint">run your code to see output here.</span>
        )}
      </div>
    </motion.div>
  );
}
