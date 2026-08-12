/**
 * Predefined accessible colour palette for users.
 * Each colour is distinct enough to be readable on dark/light backgrounds.
 */
export const USER_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57",
  "#FF9FF3", "#54A0FF", "#5F27CD", "#00D2D3", "#FF9F43",
  "#48DBFB", "#1DD1A1", "#F368E0", "#EE5A24", "#009432",
];

/** Monaco language options shown in the toolbar dropdown */
export const LANGUAGES = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python",     label: "Python" },
  { value: "java",       label: "Java" },
  { value: "cpp",        label: "C++" },
  { value: "c",          label: "C" },
  { value: "go",         label: "Go" },
  { value: "rust",       label: "Rust" },
  { value: "html",       label: "HTML" },
  { value: "css",        label: "CSS" },
  { value: "json",       label: "JSON" },
  { value: "markdown",   label: "Markdown" },
  { value: "sql",        label: "SQL" },
  { value: "bash",       label: "Bash" },
  { value: "php",        label: "PHP" },
];

/**
 * Maps a Monaco language id to the Judge0 language_id.
 * Only languages that Judge0 supports are mapped; others get undefined.
 */
export const JUDGE0_LANGUAGE_IDS = {
  javascript: 63,   // Node.js
  typescript: 74,
  python:     71,   // Python 3
  java:       62,
  cpp:        54,   // C++ (GCC 9.2.0)
  c:          50,
  go:         60,
  rust:       73,
  bash:       46,
  php:        68,
};
