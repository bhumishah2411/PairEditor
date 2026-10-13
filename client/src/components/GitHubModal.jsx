/**
 * GitHubModal – UI-driven GitHub Integration.
 * Allows users to:
 *   1. Import any public or private GitHub repository into their workspace.
 *   2. Commit and push workspace changes to a branch via GitHub Git Data API.
 *   3. Export workspace code to a GitHub Gist (or import from Gist).
 *   4. Configure Personal Access Token (stored locally in localStorage).
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitBranch,
  GitCommit,
  UploadCloud,
  DownloadCloud,
  RefreshCw,
  Download,
  ExternalLink,
  Key,
  Check,
  Loader2,
  X,
  HelpCircle,
  Eye,
  EyeOff,
  AlertCircle,
  FileCode,
  Sparkles,
} from "lucide-react";
import axios from "axios";
import GithubIcon from "./GithubIcon";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export default function GitHubModal({
  isOpen,
  onClose,
  roomId,
  workspaceId,
  currentRepo,
  filesCount = 0,
  currentUser,
  code,
  activeFile,
  files,
}) {
  const [activeTab, setActiveTab] = useState(() => currentRepo ? "pull" : "import"); // "import" | "pull" | "push" | "help"

  // ── GitHub Token State (Persisted in localStorage) ──────────────────────────
  const [token, setToken] = useState(() => localStorage.getItem("paireditor_github_token") || "");
  const [showToken, setShowToken] = useState(false);
  const [saveToken, setSaveToken] = useState(true);

  // ── Import Tab State ────────────────────────────────────────────────────────
  const [importRepoUrl, setImportRepoUrl] = useState(() => currentRepo?.repoUrl || localStorage.getItem("paireditor_github_last_repo") || "");
  const [importBranch, setImportBranch]   = useState(() => currentRepo?.branch || "");
  const [isImporting, setIsImporting]     = useState(false);
  const [importSuccess, setImportSuccess] = useState(null);
  const [importError, setImportError]     = useState(null);

  // ── Pull Tab State ──────────────────────────────────────────────────────────
  const [pullOwnerRepo, setPullOwnerRepo] = useState(() => {
    if (currentRepo?.owner && currentRepo?.repo) return `${currentRepo.owner}/${currentRepo.repo}`;
    return localStorage.getItem("paireditor_github_last_repo") || "";
  });
  const [pullBranch, setPullBranch]       = useState(() => currentRepo?.branch || "main");
  const [isPulling, setIsPulling]         = useState(false);
  const [pullSuccess, setPullSuccess]     = useState(null);
  const [pullError, setPullError]         = useState(null);

  // ── Push Tab State ──────────────────────────────────────────────────────────
  const [pushOwnerRepo, setPushOwnerRepo] = useState(() => {
    if (currentRepo?.owner && currentRepo?.repo) return `${currentRepo.owner}/${currentRepo.repo}`;
    return localStorage.getItem("paireditor_github_last_repo") || "";
  });
  const [pushBranch, setPushBranch]       = useState(() => currentRepo?.branch || "main");
  const [createBranch, setCreateBranch]   = useState(true);
  const [commitMessage, setCommitMessage] = useState("feat: collaborative update from PairEditor");
  const [isPushing, setIsPushing]         = useState(false);
  const [pushSuccess, setPushSuccess]     = useState(null);
  const [pushError, setPushError]         = useState(null);

  // Keep fields synced if currentRepo changes
  useEffect(() => {
    if (currentRepo?.owner && currentRepo?.repo) {
      const slug = `${currentRepo.owner}/${currentRepo.repo}`;
      setPushOwnerRepo(slug);
      setPullOwnerRepo(slug);
      setImportRepoUrl(currentRepo.repoUrl || slug);
      if (currentRepo.branch) {
        setPushBranch(currentRepo.branch);
        setPullBranch(currentRepo.branch);
      }
    }
  }, [currentRepo]);

  // Persist token if requested
  const handleTokenChange = (val) => {
    setToken(val);
    if (saveToken) {
      if (val) localStorage.setItem("paireditor_github_token", val.trim());
      else localStorage.removeItem("paireditor_github_token");
    }
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // ── Action: Import Repo ─────────────────────────────────────────────────────
  const handleImport = async (e) => {
    e.preventDefault();
    if (!importRepoUrl.trim()) return;

    setIsImporting(true);
    setImportError(null);
    setImportSuccess(null);

    try {
      const res = await axios.post(`${SERVER_URL}/api/github/import`, {
        roomId,
        workspaceId,
        repoUrl: importRepoUrl.trim(),
        branch: importBranch.trim() || undefined,
        token: token.trim() || undefined,
      });

      setImportSuccess(`Successfully imported ${res.data.count} files from ${res.data.owner}/${res.data.repo}@${res.data.branch}`);
      localStorage.setItem("paireditor_github_last_repo", `${res.data.owner}/${res.data.repo}`);
      setPushOwnerRepo(`${res.data.owner}/${res.data.repo}`);
      setPullOwnerRepo(`${res.data.owner}/${res.data.repo}`);
      setPushBranch(res.data.branch);
      setPullBranch(res.data.branch);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || "Failed to import repository.";
      setImportError(msg);
    } finally {
      setIsImporting(false);
    }
  };

  // ── Action: Pull Latest Changes ─────────────────────────────────────────────
  const handlePull = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!pullOwnerRepo.trim()) {
      setPullError("Please enter the repository (owner/repo) to pull.");
      return;
    }

    const parts = pullOwnerRepo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) {
      setPullError("Invalid format. Use 'owner/repo' (e.g. bhumishah2411/PairEditor).");
      return;
    }

    const [owner, repo] = parts;
    setIsPulling(true);
    setPullError(null);
    setPullSuccess(null);

    try {
      const res = await axios.post(`${SERVER_URL}/api/github/pull`, {
        roomId,
        workspaceId,
        owner,
        repo,
        branch: pullBranch.trim() || "main",
        token: token.trim() || undefined,
      });

      setPullSuccess({
        count: res.data.count,
        owner: res.data.owner,
        repo: res.data.repo,
        branch: res.data.branch,
        commitSha: res.data.commitSha,
      });
      localStorage.setItem("paireditor_github_last_repo", `${owner}/${repo}`);
      setPushOwnerRepo(`${owner}/${repo}`);
      setPushBranch(res.data.branch);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || "Failed to pull from GitHub.";
      setPullError(msg);
    } finally {
      setIsPulling(false);
    }
  };

  // ── Action: Commit & Push ───────────────────────────────────────────────────
  const handlePush = async (e) => {
    e.preventDefault();
    if (!token.trim()) {
      setPushError("A GitHub Personal Access Token is required to commit and push.");
      return;
    }
    if (!pushOwnerRepo.trim()) {
      setPushError("Please enter the target repository (owner/repo).");
      return;
    }

    if (!token.trim()) {
      setPushError("A GitHub Personal Access Token is required to commit & push changes to GitHub. Please paste your token in the field above (or create one in 'Token Setup').");
      setShowToken(true);
      return;
    }

    const parts = pushOwnerRepo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) {
      setPushError("Invalid format. Use 'owner/repo' (e.g. bhumishah2411/PairEditor).");
      return;
    }

    const [owner, repo] = parts;
    setIsPushing(true);
    setPushError(null);
    setPushSuccess(null);

    try {
      const res = await axios.post(`${SERVER_URL}/api/github/push`, {
        roomId,
        workspaceId,
        owner,
        repo,
        branch: pushBranch.trim() || "main",
        createBranch,
        message: commitMessage.trim() || "Update from PairEditor",
        token: token.trim(),
        authorName: currentUser?.name || "PairEditor User",
        authorEmail: "collab@paireditor.dev",
        activeFile: activeFile || (files?.[0]?.path) || "index.html",
        code: code !== undefined ? code : undefined,
        files: Array.isArray(files) ? files.map((f) => ({ path: f.path, language: f.language })) : [],
      });

      setPushSuccess({
        commitSha: res.data.commitSha,
        commitUrl: res.data.commitUrl,
        branch: res.data.branch,
        filesCount: res.data.filesCount,
      });
      localStorage.setItem("paireditor_github_last_repo", `${owner}/${repo}`);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || "Failed to commit and push to GitHub.";
      setPushError(msg);
    } finally {
      setIsPushing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-canvas/80 backdrop-blur-md"
      />

      {/* Modal Dialog */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="relative w-full max-w-xl bg-panel border border-line rounded-xl shadow-2xl overflow-hidden flex flex-col z-10 max-h-[90vh]"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-panel-raised/50 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-panel flex items-center justify-center border border-line text-signal shadow-sm">
              <GithubIcon size={18} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-paper flex items-center gap-2">
                GitHub Integration
                {currentRepo && (
                  <span className="text-[10px] font-mono text-signal bg-signal/10 px-2 py-0.5 rounded border border-signal/20">
                    {currentRepo.owner}/{currentRepo.repo}@{currentRepo.branch}
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-paper-faint">
                Import repos and commit & push directly to GitHub
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-paper-faint hover:text-paper hover:bg-panel transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="flex border-b border-line bg-panel-sunken px-6 pt-2 gap-2 shrink-0">
          <button
            onClick={() => setActiveTab("import")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono border-b-2 transition-all ${
              activeTab === "import"
                ? "border-signal text-signal font-semibold"
                : "border-transparent text-paper-muted hover:text-paper"
            }`}
          >
            <DownloadCloud size={13} />
            <span>Import</span>
          </button>

          <button
            onClick={() => setActiveTab("pull")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono border-b-2 transition-all ${
              activeTab === "pull"
                ? "border-signal text-signal font-semibold"
                : "border-transparent text-paper-muted hover:text-paper"
            }`}
          >
            <RefreshCw size={13} className={isPulling ? "animate-spin" : ""} />
            <span>Pull (Sync)</span>
          </button>

          <button
            onClick={() => setActiveTab("push")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-mono border-b-2 transition-all ${
              activeTab === "push"
                ? "border-signal text-signal font-semibold"
                : "border-transparent text-paper-muted hover:text-paper"
            }`}
          >
            <UploadCloud size={13} />
            <span>Commit & Push</span>
          </button>

          <button
            onClick={() => setActiveTab("help")}
            className={`ml-auto flex items-center gap-1.5 px-2.5 py-2 text-xs font-mono border-b-2 transition-all ${
              activeTab === "help"
                ? "border-signal text-signal font-semibold"
                : "border-transparent text-paper-faint hover:text-paper"
            }`}
          >
            <HelpCircle size={13} />
            <span>Token Setup</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Universal GitHub Token Input Bar (collapsed banner) */}
          <div className="p-3 bg-panel-raised/60 rounded-lg border border-line text-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-paper-muted flex items-center gap-1.5 font-medium">
                <Key size={12} className="text-signal" />
                Personal Access Token (PAT)
                <span className="text-paper-faint text-[10px]">
                  {token ? "(configured)" : "(optional for import, required to push)"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="text-paper-faint hover:text-paper transition-colors"
                title={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>

            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => handleTokenChange(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx (required for push & private repos)"
                className="w-full bg-panel px-3 py-1.5 rounded border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint/50"
              />
            </div>

            <div className="flex items-center justify-between text-[10px] text-paper-faint font-mono pt-0.5">
              <span>Saved locally in browser localStorage</span>
              <button
                type="button"
                onClick={() => setActiveTab("help")}
                className="text-signal hover:underline"
              >
                How to get a token?
              </button>
            </div>

            <div className="p-2 bg-signal/5 border border-signal/20 rounded text-[10px] font-mono text-paper-muted flex items-start gap-1.5 leading-relaxed">
              <Sparkles size={12} className="text-signal shrink-0 mt-0.5" />
              <span>
                <strong>Why is a token needed for public repos?</strong> Anyone can <em>read/import</em> public repos without a token, but GitHub requires a Personal Access Token with <code className="text-signal font-semibold">repo</code> scope to verify you own the repository before allowing you to commit and push changes.
              </span>
            </div>
          </div>

          {/* TAB 1: IMPORT REPO */}
          {activeTab === "import" && (
            <form onSubmit={handleImport} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                  Repository URL or Name <span className="text-signal">*</span>
                </label>
                <input
                  type="text"
                  value={importRepoUrl}
                  onChange={(e) => setImportRepoUrl(e.target.value)}
                  placeholder="e.g. facebook/react or https://github.com/owner/repo"
                  required
                  className="w-full bg-panel px-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint"
                />
                <p className="text-[10px] font-mono text-paper-faint mt-1">
                  Accepts shorthand <code className="text-paper-muted">owner/repo</code> or full GitHub URLs.
                </p>
              </div>

              <div>
                <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                  Branch <span className="text-paper-faint text-[10px]">(optional, defaults to main/master)</span>
                </label>
                <div className="relative">
                  <GitBranch size={13} className="absolute left-3 top-2.5 text-paper-faint" />
                  <input
                    type="text"
                    value={importBranch}
                    onChange={(e) => setImportBranch(e.target.value)}
                    placeholder="main"
                    className="w-full bg-panel pl-8 pr-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint"
                  />
                </div>
              </div>

              {/* Status alerts */}
              {importError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs font-mono text-red-400 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{importError}</span>
                </div>
              )}

              {importSuccess && (
                <div className="p-3 bg-signal/10 border border-signal/30 rounded-lg text-xs font-mono text-signal flex items-start gap-2">
                  <Check size={14} className="shrink-0 mt-0.5" />
                  <span>{importSuccess}</span>
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isImporting || !importRepoUrl.trim()}
                  className="w-full btn-signal py-2.5 rounded-lg bg-signal text-canvas font-mono font-semibold text-xs flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  {isImporting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Fetching & loading files...</span>
                    </>
                  ) : (
                    <>
                      <DownloadCloud size={14} />
                      <span>Import into Workspace</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* TAB 2: PULL / SYNC LATEST CHANGES */}
          {activeTab === "pull" && (
            <form onSubmit={handlePull} className="space-y-4">
              <div className="p-3 bg-panel-raised/50 rounded-lg border border-line text-xs font-mono space-y-2">
                <div className="flex items-center gap-2 text-paper font-semibold">
                  <RefreshCw size={14} className="text-signal" />
                  <span>Pull & Sync Latest Commits</span>
                </div>
                <p className="text-[11px] text-paper-muted leading-relaxed">
                  Pushed new code to GitHub from your terminal, VS Code, or another machine? Click pull to fetch the newest tree and update the editor buffer in real-time for everyone in this room.
                </p>
                {currentRepo?.lastCommitSha && (
                  <div className="text-[10px] text-paper-faint pt-1 border-t border-line/50 flex items-center justify-between">
                    <span>Currently synced commit:</span>
                    <span className="font-mono text-signal bg-panel px-1.5 py-0.5 rounded border border-line">
                      {currentRepo.lastCommitSha.slice(0, 7)}
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                    Repository (owner/repo) <span className="text-signal">*</span>
                  </label>
                  <input
                    type="text"
                    value={pullOwnerRepo}
                    onChange={(e) => setPullOwnerRepo(e.target.value)}
                    placeholder="e.g. bhumishah2411/PairEditor"
                    required
                    className="w-full bg-panel px-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint"
                  />
                </div>

                <div>
                  <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                    Branch <span className="text-signal">*</span>
                  </label>
                  <div className="relative">
                    <GitBranch size={13} className="absolute left-3 top-2.5 text-paper-faint" />
                    <input
                      type="text"
                      value={pullBranch}
                      onChange={(e) => setPullBranch(e.target.value)}
                      placeholder="main"
                      required
                      className="w-full bg-panel pl-8 pr-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint"
                    />
                  </div>
                </div>
              </div>

              {/* Status alerts */}
              {pullError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs font-mono text-red-400 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{pullError}</span>
                </div>
              )}

              {pullSuccess && (
                <div className="p-3 bg-signal/10 border border-signal/30 rounded-lg text-xs font-mono text-signal space-y-1.5">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Check size={14} />
                    <span>Successfully pulled latest changes!</span>
                  </div>
                  <p className="text-[11px] text-paper-muted">
                    Updated {pullSuccess.count} files from {pullSuccess.owner}/{pullSuccess.repo}@{pullSuccess.branch}
                    {pullSuccess.commitSha ? ` (${pullSuccess.commitSha.slice(0, 7)})` : ""}.
                  </p>
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isPulling || !pullOwnerRepo.trim()}
                  className="w-full btn-signal py-2.5 rounded-lg bg-signal text-canvas font-mono font-semibold text-xs flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  {isPulling ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Fetching latest tree & downloading blobs...</span>
                    </>
                  ) : (
                    <>
                      <Download size={14} />
                      <span>Pull Latest from {pullOwnerRepo || "GitHub"}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* TAB 3: COMMIT & PUSH */}
          {activeTab === "push" && (
            <form onSubmit={handlePush} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                    Target Repo (owner/repo) <span className="text-signal">*</span>
                  </label>
                  <input
                    type="text"
                    value={pushOwnerRepo}
                    onChange={(e) => setPushOwnerRepo(e.target.value)}
                    placeholder="e.g. bhumishah2411/PairEditor"
                    required
                    className="w-full bg-panel px-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint"
                  />
                </div>

                <div>
                  <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                    Branch <span className="text-signal">*</span>
                  </label>
                  <div className="relative">
                    <GitBranch size={13} className="absolute left-3 top-2.5 text-paper-faint" />
                    <input
                      type="text"
                      value={pushBranch}
                      onChange={(e) => setPushBranch(e.target.value)}
                      placeholder="main"
                      required
                      className="w-full bg-panel pl-8 pr-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="chk-create-branch"
                  checked={createBranch}
                  onChange={(e) => setCreateBranch(e.target.checked)}
                  className="rounded border-line bg-panel text-signal focus:ring-0"
                />
                <label htmlFor="chk-create-branch" className="text-xs font-mono text-paper-muted select-none cursor-pointer">
                  Create branch automatically if it does not exist yet
                </label>
              </div>

              <div>
                <label className="block text-xs font-mono text-paper-muted mb-1.5 font-medium">
                  Commit Message <span className="text-signal">*</span>
                </label>
                <textarea
                  rows={2}
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Describe what you built or modified..."
                  required
                  className="w-full bg-panel px-3 py-2 rounded-lg border border-line font-mono text-xs text-paper focus:outline-none focus:border-signal/50 placeholder:text-paper-faint resize-none"
                />
              </div>

              {/* Scope summary */}
              <div className="p-3 bg-panel-raised/40 rounded-lg border border-line flex items-center justify-between text-xs font-mono">
                <span className="text-paper-faint flex items-center gap-1.5">
                  <FileCode size={13} className="text-signal" />
                  Files in session to commit:
                </span>
                <span className="font-semibold text-paper bg-panel px-2 py-0.5 rounded border border-line">
                  {filesCount} {filesCount === 1 ? "file" : "files"}
                </span>
              </div>

              {/* Status alerts */}
              {pushError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs font-mono text-red-400 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{pushError}</span>
                </div>
              )}

              {pushSuccess && (
                <div className="p-3 bg-signal/10 border border-signal/30 rounded-lg text-xs font-mono text-signal space-y-1.5">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Check size={14} />
                    <span>Pushed successfully to {pushSuccess.branch}!</span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-paper-muted text-[11px]">
                      Commit SHA: {pushSuccess.commitSha.slice(0, 7)}
                    </span>
                    <a
                      href={pushSuccess.commitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-signal hover:underline flex items-center gap-1 font-semibold text-xs"
                    >
                      View commit on GitHub
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              )}

              {/* Shortcut to Pull first */}
              <div className="p-2.5 bg-panel-raised/40 rounded-lg border border-line flex items-center justify-between text-xs font-mono">
                <span className="text-[11px] text-paper-muted flex items-center gap-1.5">
                  <RefreshCw size={12} className="text-signal" />
                  Remote has newer changes?
                </span>
                <button
                  type="button"
                  onClick={() => setActiveTab("pull")}
                  className="text-signal hover:underline text-[11px] font-semibold"
                >
                  Pull latest first →
                </button>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isPushing || !pushOwnerRepo.trim()}
                  className="w-full btn-signal py-2.5 rounded-lg bg-signal text-canvas font-mono font-semibold text-xs flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  {isPushing ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Creating Git blobs, tree & commit...</span>
                    </>
                  ) : (
                    <>
                      <GitCommit size={14} />
                      <span>Commit & Push to GitHub</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* TAB 4: TOKEN HELP */}
          {activeTab === "help" && (
            <div className="space-y-4 text-xs font-mono leading-relaxed text-paper-muted">
              <div className="flex items-center gap-2 text-paper font-semibold">
                <Sparkles size={14} className="text-signal" />
                <span>How to generate a GitHub Personal Access Token (PAT)</span>
              </div>

              <ol className="list-decimal list-inside space-y-2.5 text-paper-muted bg-panel-raised/50 p-4 rounded-lg border border-line">
                <li>
                  Go to{" "}
                  <a
                    href="https://github.com/settings/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-signal hover:underline inline-flex items-center gap-0.5"
                  >
                    github.com/settings/tokens
                    <ExternalLink size={10} />
                  </a>
                </li>
                <li>
                  Click <strong className="text-paper">Generate new token (classic)</strong>.
                </li>
                <li>
                  Give it a note like <code className="text-signal bg-panel px-1.5 py-0.5 rounded">PairEditor</code>.
                </li>
                <li>
                  Under <strong className="text-paper">Select scopes</strong>, check the{" "}
                  <code className="text-signal bg-panel px-1.5 py-0.5 rounded">repo</code> scope
                  (Full control of private repositories).
                </li>
                <li>
                  Click <strong className="text-paper">Generate token</strong> at the bottom.
                </li>
                <li>
                  Copy your token (starts with <code className="text-paper">ghp_</code>) and paste it into the token field above!
                </li>
              </ol>

              <div className="p-3 bg-panel border border-line rounded-lg text-[11px] text-paper-faint">
                🔒 <strong>Security note:</strong> Your token is stored only in your browser’s local storage and used directly to interact with GitHub’s API on your behalf. PairEditor does not store your token on any third-party database.
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-line bg-panel-raised/30 flex items-center justify-between shrink-0">
          <span className="font-mono text-[10px] text-paper-faint">
            PairEditor Git Data Integration
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg bg-panel-raised border border-line text-xs font-mono text-paper-muted hover:text-paper hover:border-signal/30 transition-colors"
          >
            Close
          </button>
        </div>
      </motion.div>
    </div>
  );
}
