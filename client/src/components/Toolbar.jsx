/**
 * Toolbar – top status bar of the editor workspace.
 * Contains: room info, language selector, run button, theme toggle, copy link.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import {
  Play, Copy, Check, Sun, Moon, ChevronDown, Loader2, Download,
} from "lucide-react";
import { LANGUAGES } from "../utils/constants";
import ConnectionStatus from "./ConnectionStatus";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export default function Toolbar({
  roomId,
  language,
  connected,
  isDark,
  activeFile,
  hasFiles,
  onToggleTheme,
  onLanguageChange,
  onRun,
  isRunning,
}) {
  const [copied, setCopied]       = useState(false);
  const [langOpen, setLangOpen]   = useState(false);
  const [downloading, setDownloading] = useState(false);

  const copyRoomLink = () => {
    const link = `${window.location.origin}?room=${roomId}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const currentLang = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0];

  const downloadProject = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/room/${roomId}/download`);
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pairEditor-${roomId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      // Silently no-op — button stays enabled so the user can retry
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-line bg-panel shrink-0 relative z-20">
      {/* Left – wordmark + room breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-mono text-sm text-paper font-semibold hidden sm:flex items-center shrink-0">
          pair<span className="text-signal">editor</span>
          <span className="cursor-block ml-0.5" />
        </span>
        <div className="h-4 w-px bg-line hidden sm:block" />
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs text-paper-faint shrink-0">Room:</span>
          <span className="font-mono text-xs font-semibold text-paper bg-panel-raised px-2.5 py-1 rounded border border-line truncate">
            {roomId}
          </span>
        </div>
        {activeFile && (
          <>
            <div className="h-4 w-px bg-line hidden md:block" />
            <span className="hidden md:inline font-mono text-xs text-signal truncate max-w-[220px]" title={activeFile}>
              {activeFile}
            </span>
          </>
        )}
      </div>

      {/* Centre – language picker */}
      <div className="relative">
        <button
          id="btn-language-picker"
          onClick={() => setLangOpen((p) => !p)}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-panel-raised border border-line text-sm text-paper hover:border-signal/30 transition-colors"
        >
          <span className="font-mono text-xs">{currentLang.label}</span>
          <ChevronDown size={13} className={`transition-transform text-paper-faint ${langOpen ? "rotate-180" : ""}`} />
        </button>

        {langOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute top-full mt-1 left-0 w-44 panel-glass rounded-lg shadow-2xl overflow-hidden z-50"
            onMouseLeave={() => setLangOpen(false)}
          >
            <div className="max-h-64 overflow-y-auto py-1">
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  onClick={() => { onLanguageChange(l.value); setLangOpen(false); }}
                  className={`w-full text-left px-4 py-2 font-mono text-xs transition-colors ${
                    l.value === language
                      ? "text-signal bg-signal/10"
                      : "text-paper-muted hover:bg-panel-raised hover:text-paper"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </div>

      {/* Right – actions */}
      <div className="flex items-center gap-2">
        <ConnectionStatus connected={connected} />

        {/* Run code */}
        <button
          id="btn-run-code"
          onClick={onRun}
          disabled={isRunning}
          className="btn-signal flex items-center gap-1.5 px-3 py-1.5 rounded bg-signal text-canvas text-xs font-semibold transition-all disabled:opacity-50"
        >
          {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {isRunning ? "running…" : "run"}
        </button>

        {/* Copy room link */}
        <button
          id="btn-copy-link"
          onClick={copyRoomLink}
          title="Copy room link"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-panel-raised border border-line text-xs text-paper-muted hover:text-paper hover:border-signal/30 transition-colors"
        >
          {copied ? <Check size={13} className="text-signal" /> : <Copy size={13} />}
          {copied ? "copied" : "share"}
        </button>

        {/* Download project as .zip */}
        {hasFiles && (
          <button
            id="btn-download-project"
            onClick={downloadProject}
            disabled={downloading}
            title="Download project as .zip"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-panel-raised border border-line text-xs text-paper-muted hover:text-paper hover:border-signal/30 transition-colors disabled:opacity-50"
          >
            {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {downloading ? "zipping…" : "download"}
          </button>
        )}

        {/* Theme toggle */}
        <button
          id="btn-theme-toggle"
          onClick={onToggleTheme}
          title="Toggle theme"
          className="w-8 h-8 flex items-center justify-center rounded bg-panel-raised border border-line text-paper-muted hover:text-paper hover:border-signal/30 transition-colors"
        >
          {isDark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </div>
  );
}
