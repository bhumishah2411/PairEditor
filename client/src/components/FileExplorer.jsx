/**
 * FileExplorer – upload a local folder and browse it as a tree.
 * Clicking a file switches the room's shared editor buffer to it
 * (everyone in the room follows, same as the rest of this app's model).
 */
import { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Folder, FolderOpen, FileCode, ChevronRight, FolderUp, Loader2 } from "lucide-react";
import { buildFileTree } from "../utils/fileTree";

export default function FileExplorer({ files, activeFile, isUploading, onUploadFolder, onSelectFile }) {
  const inputRef = useRef(null);
  const [expanded, setExpanded] = useState(new Set());

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

  return (
    <div className="flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
        <span className="font-mono text-[11px] text-paper-faint">$ ls -R</span>
        <button
          id="btn-upload-folder"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
          title="Upload folder"
          className="ml-auto flex items-center gap-1 font-mono text-[10px] text-paper-muted hover:text-signal border border-line hover:border-signal/40 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
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
            onSelectFile={onSelectFile}
          />
        )}
      </div>
    </div>
  );
}

function TreeNodes({ nodes, depth, expanded, onToggleFolder, activeFile, onSelectFile }) {
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
            onSelectFile={onSelectFile}
          />
        ) : (
          <FileRow
            key={node.path}
            node={node}
            depth={depth}
            isActive={node.path === activeFile}
            onSelectFile={onSelectFile}
          />
        )
      )}
    </>
  );
}

function FolderRow({ node, depth, expanded, onToggleFolder, activeFile, onSelectFile }) {
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
            onSelectFile={onSelectFile}
          />
        </motion.div>
      )}
    </div>
  );
}

function FileRow({ node, depth, isActive, onSelectFile }) {
  return (
    <button
      onClick={() => onSelectFile(node.path)}
      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors ${
        isActive ? "bg-signal/12 text-signal" : "text-paper-muted hover:bg-panel-raised/70 hover:text-paper"
      }`}
      style={{ paddingLeft: `${8 + depth * 14 + 14}px` }}
      title={node.path}
    >
      <FileCode size={13} className="shrink-0" />
      <span className="font-mono text-xs truncate">{node.name}</span>
    </button>
  );
}
