/**
 * FileExplorer – upload a local folder and browse it as a tree.
 * Clicking a file switches the room's shared editor buffer to it
 * (everyone in the room follows, same as the rest of this app's model).
 */
import { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Folder, FolderOpen, FileCode, ChevronRight, FolderUp, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { buildFileTree } from "../utils/fileTree";

export default function FileExplorer({ files, activeFile, isUploading, onUploadFolder, onCreateFile, onRenameFile, onDeleteFile, onSelectFile }) {
  const inputRef = useRef(null);
  const [expanded, setExpanded] = useState(new Set());
  const [editingPath, setEditingPath] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");

  const tree = buildFileTree(files);

  const toggleFolder = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const handlePick = (e) => {
    if (e.target.files?.length) onUploadFolder(e.target.files);
    e.target.value = ""; // allow re-picking the same folder later
  };

  const handleCreateFile = () => {
    const suggested = "untitled.js";
    const name = window.prompt("Create new file", suggested)?.trim();
    if (!name) return;
    onCreateFile?.(name);
  };

  const startRename = (path, name) => {
    setEditingPath(path);
    setRenameDraft(name);
  };

  const cancelRename = () => {
    setEditingPath(null);
    setRenameDraft("");
  };

  const commitRename = (path) => {
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }

    const currentName = path.split("/").pop();
    if (trimmed === currentName) {
      cancelRename();
      return;
    }

    onRenameFile?.(path, trimmed);
    cancelRename();
  };

  return (
    <div className="flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
        <span className="font-mono text-[11px] text-paper-faint whitespace-nowrap">$ ls -R</span>
        <button
          type="button"
          onClick={handleCreateFile}
          title="Create new file"
          className="ml-1 flex items-center gap-1 font-mono text-[10px] text-paper-muted hover:text-signal border border-line hover:border-signal/40 rounded px-1.5 py-0.5 transition-colors whitespace-nowrap"
        >
          <Plus size={11} />
          new file
        </button>
        <button
          id="btn-upload-folder"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
          title="Upload folder"
          className="ml-auto flex items-center gap-1 font-mono text-[10px] text-paper-muted hover:text-signal border border-line hover:border-signal/40 rounded px-1.5 py-0.5 transition-colors whitespace-nowrap disabled:opacity-50"
        >
          {isUploading ? <Loader2 size={11} className="animate-spin" /> : <FolderUp size={11} />}
          {isUploading ? "reading…" : "upload"}
        </button>
        <input
          ref={inputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={handlePick}
        />
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {tree.length === 0 ? (
          <p className="font-mono text-[11px] text-paper-faint text-center px-3 py-6 leading-relaxed">
            no folder loaded.
            <br />
            click <span className="text-signal">upload</span> to bring in a project.
          </p>
        ) : (
          <TreeNodes
            nodes={tree}
            depth={0}
            expanded={expanded}
            onToggleFolder={toggleFolder}
            activeFile={activeFile}
            editingPath={editingPath}
            renameDraft={renameDraft}
            onRenameDraftChange={setRenameDraft}
            onStartRename={startRename}
            onCancelRename={cancelRename}
            onCommitRename={commitRename}
            onDeleteFile={onDeleteFile}
            onSelectFile={onSelectFile}
            onRenameFile={onRenameFile}
          />
        )}
      </div>
    </div>
  );
}

function TreeNodes({ nodes, depth, expanded, onToggleFolder, activeFile, editingPath, renameDraft, onRenameDraftChange, onStartRename, onCancelRename, onCommitRename, onDeleteFile, onSelectFile, onRenameFile }) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "folder" ? (
          <FolderRow
            key={node.path}
            node={node}
            depth={depth}
            expanded={expanded}
            onToggleFolder={onToggleFolder}
            activeFile={activeFile}
            editingPath={editingPath}
            renameDraft={renameDraft}
            onRenameDraftChange={onRenameDraftChange}
            onStartRename={onStartRename}
            onCancelRename={onCancelRename}
            onCommitRename={onCommitRename}
            onDeleteFile={onDeleteFile}
            onSelectFile={onSelectFile}
            onRenameFile={onRenameFile}
          />
        ) : (
          <FileRow
            key={node.path}
            node={node}
            depth={depth}
            isActive={node.path === activeFile}
            isEditing={editingPath === node.path}
            renameDraft={renameDraft}
            onRenameDraftChange={onRenameDraftChange}
            onStartRename={onStartRename}
            onCancelRename={onCancelRename}
            onCommitRename={onCommitRename}
            onDeleteFile={onDeleteFile}
            onSelectFile={onSelectFile}
            onRenameFile={onRenameFile}
          />
        )
      )}
    </>
  );
}

function FolderRow({
  node,
  depth,
  expanded,
  onToggleFolder,
  activeFile,
  editingPath,
  renameDraft,
  onRenameDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onDeleteFile,
  onSelectFile,
  onRenameFile,
}) {
  const isOpen = expanded.has(node.path);
  return (
    <div>
      <button
        onClick={() => onToggleFolder(node.path)}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left hover:bg-panel-raised/70 transition-colors"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <ChevronRight
          size={11}
          className={`text-paper-faint shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
        />
        {isOpen ? (
          <FolderOpen size={13} className="text-signal shrink-0" />
        ) : (
          <Folder size={13} className="text-paper-muted shrink-0" />
        )}
        <span className="font-mono text-xs text-paper-muted truncate">{node.name}</span>
      </button>
      {isOpen && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
          <TreeNodes
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            onToggleFolder={onToggleFolder}
            activeFile={activeFile}
            editingPath={editingPath}
            renameDraft={renameDraft}
            onRenameDraftChange={onRenameDraftChange}
            onStartRename={onStartRename}
            onCancelRename={onCancelRename}
            onCommitRename={onCommitRename}
            onDeleteFile={onDeleteFile}
            onSelectFile={onSelectFile}
            onRenameFile={onRenameFile}
          />
        </motion.div>
      )}
    </div>
  );
}

function FileRow({
  node,
  depth,
  isActive,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onDeleteFile,
  onSelectFile,
  onRenameFile,
}) {
  const handleDelete = (e) => {
    e.stopPropagation();
    const confirmed = window.confirm(`Delete "${node.name}"?`);
    if (!confirmed) return;
    onDeleteFile?.(node.path);
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1" style={{ paddingLeft: `${8 + depth * 14 + 14}px` }}>
        <FileCode size={13} className="shrink-0 text-paper-muted" />
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => onRenameDraftChange(e.target.value)}
          onBlur={() => onCommitRename(node.path)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(node.path);
            if (e.key === "Escape") onCancelRename();
          }}
          className="min-w-0 flex-1 bg-panel-raised border border-signal/40 rounded px-1.5 py-0.5 font-mono text-[11px] text-paper outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className={`group flex w-full items-center gap-1.5 rounded transition-colors ${
        isActive ? "bg-signal/12 text-signal" : "text-paper-muted hover:bg-panel-raised/70 hover:text-paper"
      }`}
      style={{ paddingLeft: `${8 + depth * 14 + 14}px` }}
      title={node.path}
    >
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
      >
        <FileCode size={13} className="shrink-0" />
        <span className="font-mono text-xs truncate">{node.name}</span>
      </button>

      <div className="mr-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStartRename(node.path, node.name);
          }}
          className="flex h-5 w-5 items-center justify-center rounded border border-line bg-panel-raised text-paper-muted hover:text-paper transition-colors"
          title="Rename file"
          aria-label={`Rename ${node.name}`}
        >
          <Pencil size={11} />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          className="flex h-5 w-5 items-center justify-center rounded border border-line bg-panel-raised text-paper-muted hover:text-danger transition-colors"
          title="Delete file"
          aria-label={`Delete ${node.name}`}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
