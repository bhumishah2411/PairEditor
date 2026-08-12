/**
 * fileTree – helpers for turning a flat list of uploaded file paths
 * into a nested folder/file tree, and for guessing a Monaco language
 * from a file's extension.
 */

/** Extension → Monaco language id (mirrors LANGUAGES in constants.js) */
const EXT_TO_LANGUAGE = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python",
  java: "java",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  c: "c", h: "c",
  go: "go",
  rs: "rust",
  html: "html", htm: "html",
  css: "css",
  json: "json",
  md: "markdown", markdown: "markdown",
  sql: "sql",
  sh: "bash", bash: "bash",
  php: "php",
};

export function languageForPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return EXT_TO_LANGUAGE[ext] || "plaintext";
}

/** Directories and extensions to skip when reading an uploaded folder */
const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", "__pycache__",
]);
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "pdf", "zip", "tar", "gz",
  "woff", "woff2", "ttf", "eot", "mp4", "mp3", "wav", "exe", "dll", "so", "lock",
]);
const MAX_FILE_BYTES = 300 * 1024; // 300KB per file — keeps room state light

export function shouldIncludeFile(relativePath, sizeBytes) {
  const parts = relativePath.split("/");
  if (parts.some((p) => SKIP_DIR_NAMES.has(p))) return false;
  const ext = relativePath.split(".").pop()?.toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (sizeBytes > MAX_FILE_BYTES) return false;
  return true;
}

/**
 * Build a nested tree from a flat list of { path, language } entries.
 * Returns an array of nodes: { type: "folder"|"file", name, path, children? }
 * Folders are sorted before files, both alphabetically.
 */
export function buildFileTree(files) {
  const root = { type: "folder", name: "", path: "", children: new Map() };

  files.forEach(({ path, language }) => {
    const segments = path.split("/");
    let node = root;
    segments.forEach((segment, i) => {
      const isFile = i === segments.length - 1;
      const currentPath = segments.slice(0, i + 1).join("/");
      if (!node.children.has(segment)) {
        node.children.set(segment, isFile
          ? { type: "file", name: segment, path: currentPath, language }
          : { type: "folder", name: segment, path: currentPath, children: new Map() }
        );
      }
      node = node.children.get(segment);
    });
  });

  const toArray = (node) => {
    if (node.type === "file") return node;
    const children = [...node.children.values()]
      .map(toArray)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { ...node, children };
  };

  return toArray(root).children;
}
