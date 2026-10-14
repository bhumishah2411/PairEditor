/**
 * PairEditor – Real-time Collaborative Code Editor
 * Backend: Express + Socket.IO
 *
 * Architecture:
 *  - ONE shared workspace per room (code, files, line authors, whiteboard, viewMode, githubRepo).
 *  - Created when the first user joins, deleted when the last user leaves.
 *  - Each member has their own active file (memberActiveFile Map<socketId, path>).
 *  - Single writer per file (fileLocks Map<path, lockInfo>), everyone else read-only with live updates.
 *  - Live cursor of lock owner is broadcast to members viewing that file.
 *  - Activity feed (last 100 events, typing debounced to 1 line / 10s).
 *  - GitHub integration preserved: per-user token on server, Co-authored-by trailers added on push.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const archiver = require("archiver");

const app = express();
const server = http.createServer(app);

// ── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Socket.IO setup ─────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── In-memory room store ────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, roomState>
 * roomState: {
 *   id: string,
 *   users: Map<socketId, { id, name, color, cursor, githubUser: { login, name, email } | null }>,
 *   files: Map<path, { code, language, originalCode, lastEditedBy: { name, timestamp } | null }>,
 *   memberActiveFile: Map<socketId, path>,
 *   fileLocks: Map<path, { userId, userName, color, lockedAt, lastActivityAt }>,
 *   lockTimeouts: Map<path, { warnTimer, expireTimer }>,
 *   lockRequests: Map<path, Map<fromUserId, { timer, fromUserName, fromColor }>>,
 *   lineAuthorsByFile: Map<path, Map<lineNumber, { name, color, userId }>>,
 *   whiteboard: Array,
 *   viewMode: "code" | "split" | "whiteboard",
 *   githubRepo: Object | null,
 *   activities: Array<{ id, type, text, userId, userName, color, timestamp, path }>,
 *   typingDebounce: Map<string, { lastTime, count }>, // key: `${userId}:${path}`
 * }
 */
const rooms = new Map();
/** Global lock store Map<roomId, Map<filePath, { socketId, userName, userColor, acquiredAt }>> */
const roomFileLocks = new Map();

/** Predefined user colours so each visitor gets a unique accent */
const USER_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57",
  "#FF9FF3", "#54A0FF", "#5F27CD", "#00D2D3", "#FF9F43",
  "#48DBFB", "#1DD1A1", "#F368E0", "#EE5A24", "#009432",
];

function pickColor(usedColors) {
  for (const c of USER_COLORS) {
    if (!usedColors.includes(c)) return c;
  }
  return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

function guessLanguageFromPath(path) {
  const ext = String(path || "").split(".").pop()?.toLowerCase();
  const map = {
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
  return map[ext] || "plaintext";
}

/** Get or initialize a room with a fresh shared workspace */
function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    const defaultFile = "index.js";
    const initialFiles = new Map();
    initialFiles.set(defaultFile, {
      code: "// Welcome to PairEditor!\n// Start coding here or upload a folder.\n\nconsole.log(\"Hello from PairEditor!\");\n",
      language: "javascript",
      originalCode: null,
      lastEditedBy: null,
    });

    const fileLocksMap = new Map();
    roomFileLocks.set(roomId, fileLocksMap);

    rooms.set(roomId, {
      id: roomId,
      users: new Map(),
      files: initialFiles,
      memberActiveFile: new Map(),
      fileLocks: fileLocksMap,
      lockTimeouts: new Map(),
      lockRequests: new Map(),
      lineAuthorsByFile: new Map([[defaultFile, new Map()]]),
      whiteboard: [],
      viewMode: "code",
      githubRepo: null,
      activities: [],
      typingDebounce: new Map(),
    });
  }
  return rooms.get(roomId);
}

/** Format presence user list */
function getTeamUsers(room) {
  if (!room || !room.users) return [];
  return [...room.users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    color: u.color,
    cursor: u.cursor,
    githubUser: u.githubUser || null,
  }));
}

/** Format file list with lock and viewer information */
function fileListFor(room) {
  if (!room || !room.files) return [];
  return [...room.files.keys()].map((path) => {
    const f = room.files.get(path);
    const lock = room.fileLocks.get(path) || null;
    const viewers = [...room.memberActiveFile.entries()]
      .filter(([_, p]) => p === path)
      .map(([sId]) => {
        const u = room.users.get(sId);
        return u ? { id: u.id, name: u.name, color: u.color } : null;
      })
      .filter(Boolean);

    return {
      path,
      language: f.language,
      isModified: Boolean(f?.originalCode !== undefined && f?.originalCode !== null && f?.originalCode !== f.code),
      lastEditedBy: f.lastEditedBy || null,
      lock: lock ? {
        userId: lock.userId,
        userName: lock.userName,
        color: lock.color,
        lockedAt: lock.lockedAt,
      } : null,
      viewers,
    };
  });
}

/** Record an activity event in room memory (max 100) and broadcast to room */
function logActivity(room, { type, text, userId, userName, color, path }) {
  if (!room) return;
  const event = {
    id: uuidv4(),
    type,
    text,
    userId: userId || "system",
    userName: userName || "System",
    color: color || "#6FE3A6",
    path: path || null,
    timestamp: Date.now(),
  };

  room.activities.push(event);
  if (room.activities.length > 100) {
    room.activities.shift();
  }

  io.to(room.id).emit("activity-event", event);
}

/** Clear lock expiration timers for a file */
function clearLockTimers(room, path) {
  const timers = room.lockTimeouts.get(path);
  if (timers) {
    if (timers.warnTimer) clearTimeout(timers.warnTimer);
    if (timers.expireTimer) clearTimeout(timers.expireTimer);
    room.lockTimeouts.delete(path);
  }
}

/** Set/Reset 9-minute warning and 10-minute auto-release timers for a file lock (Spec 4) */
function scheduleLockTimers(room, path) {
  clearLockTimers(room, path);

  const lock = room.fileLocks.get(path);
  if (!lock) return;

  // 1 minute before 10 minutes (9 minutes = 540 seconds)
  const warnTimer = setTimeout(() => {
    const currentLock = room.fileLocks.get(path);
    if (currentLock && currentLock.userId === lock.userId) {
      io.to(lock.userId).emit("file-lock-expiring", {
        path,
        remainingSeconds: 60,
      });
    }
  }, 9 * 60 * 1000);

  // 10 minutes (600 seconds)
  const expireTimer = setTimeout(() => {
    const currentLock = room.fileLocks.get(path);
    if (currentLock && currentLock.userId === lock.userId) {
      releaseFileLock(room, path, "expired");
    }
  }, 10 * 60 * 1000);

  room.lockTimeouts.set(path, { warnTimer, expireTimer });
}

/** Release a lock on a file */
function releaseFileLock(room, path, reason = "released") {
  if (!room || !room.fileLocks.has(path)) return false;

  const lock = room.fileLocks.get(path);
  clearLockTimers(room, path);
  room.fileLocks.delete(path);

  // Clear any pending lock requests for this file
  const requests = room.lockRequests.get(path);
  if (requests) {
    for (const [fromId, req] of requests.entries()) {
      clearTimeout(req.timer);
      io.to(fromId).emit("file-lock-request-expired", { path });
    }
    room.lockRequests.delete(path);
  }

  // Broadcast lock state updates (support both file-locks-update and spec-defined file-locks-updated)
  const lockPayload = {
    locks: Object.fromEntries(room.fileLocks),
    files: fileListFor(room),
  };
  io.to(room.id).emit("file-locks-update", lockPayload);
  io.to(room.id).emit("file-locks-updated", lockPayload);

  if (reason === "expired") {
    io.to(lock.userId).emit("file-lock-lost", {
      path,
      reason: "Lock expired after 10 minutes of inactivity.",
    });
    logActivity(room, {
      type: "lock-expired",
      text: `${lock.userName}'s lock on ${path} expired due to inactivity`,
      userId: lock.userId,
      userName: lock.userName,
      color: lock.color,
      path,
    });
  }

  return true;
}

/** Release all locks held by a specific socket */
function releaseUserLocks(room, socketId) {
  if (!room) return;
  for (const [path, lock] of room.fileLocks.entries()) {
    if (lock.userId === socketId) {
      releaseFileLock(room, path, "switched");
    }
  }
}

// ── REST helpers ─────────────────────────────────────────────────────────────
/** Generate a fresh room ID */
app.get("/api/room/new", (_req, res) => {
  const roomId = uuidv4().slice(0, 8);
  res.json({ roomId });
});

/** Health check */
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

/**
 * Download everything in the shared room workspace as a .zip.
 */
app.get("/api/room/:roomId/download", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (!room || !room.files || room.files.size === 0) {
    return res.status(404).json({ error: "No files found to download." });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="pairEditor-${roomId}.zip"`
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("[download] archive error:", err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  room.files.forEach(({ code }, path) => {
    archive.append(code ?? "", { name: path });
  });

  archive.finalize();
});

// ── GitHub Integration Endpoints ─────────────────────────────────────────────
function parseGitHubUrl(input) {
  if (!input) return null;
  let str = input.trim().replace(/\.git$/, "");
  const treeMatch = str.match(/github\.com\/([^\/]+)\/([^\/]+)\/tree\/(.+)/i);
  if (treeMatch) {
    return { owner: treeMatch[1], repo: treeMatch[2], branch: treeMatch[3] };
  }
  const urlMatch = str.match(/github\.com\/([^\/]+)\/([^\/]+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], branch: null };
  }
  const slashMatch = str.match(/^([^\/]+)\/([^\/]+)$/);
  if (slashMatch) {
    return { owner: slashMatch[1], repo: slashMatch[2], branch: null };
  }
  return null;
}

/**
 * Import a GitHub repository into the shared room workspace.
 * POST /api/github/import
 * Body: { roomId, repoUrl, branch, token }
 */
app.post("/api/github/import", async (req, res) => {
  const { roomId, repoUrl, branch: reqBranch, token } = req.body;
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return res.status(400).json({
      error: "Invalid repository format. Please enter 'owner/repo' (e.g. facebook/react) or full GitHub URL.",
    });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  // Check if any existing file is currently locked by someone
  if (room.fileLocks.size > 0) {
    const lockedFiles = [...room.fileLocks.entries()]
      .map(([p, l]) => `${p} (${l.userName})`)
      .join(", ");
    return res.status(400).json({
      error: `Cannot import while files are locked by other members: ${lockedFiles}. Please ask them to release their locks first.`,
    });
  }

  const { owner, repo } = parsed;
  let branch = reqBranch || parsed.branch;

  const headers = {
    "User-Agent": "PairEditor-App",
    "Accept": "application/vnd.github.v3+json",
  };
  if (token && token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  try {
    if (!branch) {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) {
        if (repoRes.status === 404) {
          return res.status(404).json({
            error: `Repository '${owner}/${repo}' not found. If it is private, please provide a GitHub Personal Access Token.`,
          });
        }
        if (repoRes.status === 401 || repoRes.status === 403) {
          const errData = await repoRes.json().catch(() => ({}));
          return res.status(repoRes.status).json({
            error: errData.message || "GitHub API rate limit exceeded or invalid token. Please provide a Personal Access Token.",
          });
        }
        return res.status(repoRes.status).json({ error: "Failed to fetch repository from GitHub." });
      }
      const repoData = await repoRes.json();
      branch = repoData.default_branch || "main";
    }

    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) {
      return res.status(treeRes.status).json({
        error: `Could not fetch branch '${branch}' for ${owner}/${repo}. Check if the branch name is correct.`,
      });
    }
    const treeData = await treeRes.json();
    if (!treeData.tree || !Array.isArray(treeData.tree)) {
      return res.status(400).json({ error: "No files found in the specified repository branch." });
    }

    const IGNORED_PREFIXES = ["node_modules/", ".git/", ".vscode/", ".idea/", "dist/", "build/", ".next/", "vendor/"];
    const IGNORED_EXTS = new Set([
      "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "tar", "gz",
      "exe", "dll", "so", "dylib", "mp3", "mp4", "wav", "woff", "woff2", "ttf", "eot",
      "lock", "bin", "pyc", "class", "jar"
    ]);

    const candidateFiles = treeData.tree.filter((item) => {
      if (item.type !== "blob") return false;
      const p = item.path;
      if (IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes("/" + prefix))) return false;
      const ext = p.split(".").pop()?.toLowerCase();
      if (IGNORED_EXTS.has(ext)) return false;
      if (item.size && item.size > 250 * 1024) return false;
      return true;
    }).slice(0, 100);

    if (candidateFiles.length === 0) {
      return res.status(400).json({ error: "No editable source code files found in repository." });
    }

    const fetchedFiles = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < candidateFiles.length; i += BATCH_SIZE) {
      const batch = candidateFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          try {
            const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${item.sha}`, {
              headers: { ...headers, Accept: "application/vnd.github.raw+json" },
            });
            if (blobRes.ok) {
              const text = await blobRes.text();
              return { path: item.path, content: text, language: guessLanguageFromPath(item.path) };
            }
          } catch (e) {
            console.warn(`[github/import] Failed blob fetch for ${item.path}:`, e.message);
          }
          return null;
        })
      );
      fetchedFiles.push(...batchResults.filter(Boolean));
    }

    if (fetchedFiles.length === 0) {
      return res.status(500).json({ error: "Failed to download file contents from GitHub." });
    }

    // Overwrite room files
    room.files.clear();
    room.lineAuthorsByFile.clear();
    fetchedFiles.forEach(({ path, content, language }) => {
      room.files.set(path, {
        code: content,
        language,
        originalCode: content,
        lastEditedBy: null,
      });
      room.lineAuthorsByFile.set(path, new Map());
    });

    room.githubRepo = {
      owner,
      repo,
      branch,
      repoUrl: `https://github.com/${owner}/${repo}`,
      importedAt: Date.now(),
    };

    // Broadcast file tree update & repo info to room
    io.to(room.id).emit("files-update", {
      files: fileListFor(room),
    });
    io.to(room.id).emit("github-repo-linked", room.githubRepo);

    // Refresh active file content for each connected member
    for (const [socketId, activePath] of room.memberActiveFile.entries()) {
      let targetPath = activePath;
      if (!room.files.has(targetPath)) {
        targetPath = fetchedFiles[0].path;
        room.memberActiveFile.set(socketId, targetPath);
      }
      const f = room.files.get(targetPath);
      io.to(socketId).emit("file-opened", {
        path: targetPath,
        code: f.code,
        language: f.language,
        originalCode: f.originalCode ?? null,
        lineAuthors: {},
      });
    }

    logActivity(room, {
      type: "github-import",
      text: `Imported ${fetchedFiles.length} files from ${owner}/${repo}@${branch}`,
      path: null,
    });

    io.to(room.id).emit("chat-message", {
      id: uuidv4(),
      userId: "system",
      userName: "GitHub",
      color: "#6FE3A6",
      message: `📦 Imported ${fetchedFiles.length} files from ${owner}/${repo}@${branch}`,
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      count: fetchedFiles.length,
      owner,
      repo,
      branch,
      githubRepo: room.githubRepo,
    });
  } catch (err) {
    console.error("[github/import] error:", err);
    res.status(500).json({ error: err.message || "Failed to import from GitHub." });
  }
});

/**
 * Commit and push current workspace files to GitHub using Git Data API.
 * Co-authored-by trailers are added for other room members connected to GitHub.
 * POST /api/github/push
 */
app.post("/api/github/push", async (req, res) => {
  const {
    roomId,
    owner,
    repo,
    branch,
    createBranch,
    message,
    token,
    authorName,
    authorEmail,
    userId,
  } = req.body;

  if (!token || !token.trim()) {
    return res.status(400).json({
      error: "GitHub Personal Access Token is required to commit and push changes.",
    });
  }
  if (!owner || !repo || !branch) {
    return res.status(400).json({
      error: "Repository owner, repo name, and branch are required.",
    });
  }

  const room = rooms.get(roomId);
  if (!room || !room.files || room.files.size === 0) {
    return res.status(400).json({ error: "No files found in workspace to commit." });
  }

  const cleanToken = token.trim();
  const headers = {
    "User-Agent": "PairEditor-App",
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${cleanToken}`,
    "Content-Type": "application/json",
  };

  try {
    let latestCommitSha = null;
    let refRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers }
    );

    if (refRes.status === 404 && createBranch) {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) {
        return res.status(repoRes.status).json({ error: `Repository '${owner}/${repo}' not found or access denied.` });
      }
      const repoData = await repoRes.json();
      const defaultBranch = repoData.default_branch || "main";

      const defRefRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
        { headers }
      );
      if (!defRefRes.ok) {
        return res.status(defRefRes.status).json({ error: `Could not read default branch '${defaultBranch}'.` });
      }
      const defRefData = await defRefRes.json();
      const baseSha = defRefData.object.sha;

      const createRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
      });
      if (!createRefRes.ok) {
        const err = await createRefRes.json().catch(() => ({}));
        return res.status(createRefRes.status).json({ error: err.message || `Failed to create branch '${branch}'.` });
      }
      const createRefData = await createRefRes.json();
      latestCommitSha = createRefData.object.sha;
    } else if (!refRes.ok) {
      if (refRes.status === 404) {
        return res.status(404).json({
          error: `Branch '${branch}' does not exist on ${owner}/${repo}. Check 'Create branch if not exists' to create it automatically.`,
        });
      }
      if (refRes.status === 401 || refRes.status === 403) {
        return res.status(refRes.status).json({
          error: "Authentication failed. Ensure your Personal Access Token has 'repo' scope permissions.",
        });
      }
      return res.status(refRes.status).json({ error: `Failed to fetch branch '${branch}'.` });
    } else {
      const refData = await refRes.json();
      latestCommitSha = refData.object.sha;
    }

    const commitRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`,
      { headers }
    );
    if (!commitRes.ok) {
      return res.status(commitRes.status).json({ error: "Failed to fetch base commit." });
    }
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // Create blobs for all workspace files
    const treeEntries = [];
    for (const [filePath, fileObj] of room.files.entries()) {
      const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: fileObj.code || "",
          encoding: "utf-8",
        }),
      });
      if (!blobRes.ok) {
        const err = await blobRes.json().catch(() => ({}));
        return res.status(blobRes.status).json({
          error: `Failed to create Git blob for '${filePath}': ${err.message || ""}`,
        });
      }
      const blobData = await blobRes.json();
      treeEntries.push({
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: blobData.sha,
      });
    }

    const newTreeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    if (!newTreeRes.ok) {
      const err = await newTreeRes.json().catch(() => ({}));
      return res.status(newTreeRes.status).json({ error: `Failed to create Git tree: ${err.message || ""}` });
    }
    const newTreeData = await newTreeRes.json();
    const newTreeSha = newTreeData.sha;

    // ── Build Commit Message with Co-authored-by Trailers ──
    const coAuthorTrailers = [];
    const seenEmails = new Set([authorEmail?.toLowerCase()]);

    for (const [sId, member] of room.users.entries()) {
      if (sId === userId) continue;
      const gh = member.githubUser;
      if (gh && gh.email && !seenEmails.has(gh.email.toLowerCase())) {
        seenEmails.add(gh.email.toLowerCase());
        coAuthorTrailers.push(`Co-authored-by: ${gh.name || member.name} <${gh.email}>`);
      } else if (gh && gh.login) {
        const fallbackEmail = `${gh.login}@users.noreply.github.com`;
        if (!seenEmails.has(fallbackEmail.toLowerCase())) {
          seenEmails.add(fallbackEmail.toLowerCase());
          coAuthorTrailers.push(`Co-authored-by: ${gh.name || member.name} <${fallbackEmail}>`);
        }
      }
    }

    let fullCommitMsg = (message || "feat: collaborative update from PairEditor").trim();
    if (coAuthorTrailers.length > 0) {
      fullCommitMsg += `\n\n${coAuthorTrailers.join("\n")}`;
    }

    const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: fullCommitMsg,
        tree: newTreeSha,
        parents: [latestCommitSha],
        author: {
          name: authorName || "PairEditor User",
          email: authorEmail || "collab@paireditor.dev",
          date: new Date().toISOString(),
        },
      }),
    });
    if (!newCommitRes.ok) {
      const err = await newCommitRes.json().catch(() => ({}));
      return res.status(newCommitRes.status).json({ error: `Failed to create commit: ${err.message || ""}` });
    }
    const newCommitData = await newCommitRes.json();
    const newCommitSha = newCommitData.sha;

    const updateRefRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha: newCommitSha, force: false }),
      }
    );
    if (!updateRefRes.ok) {
      const err = await updateRefRes.json().catch(() => ({}));
      return res.status(updateRefRes.status).json({
        error: `Failed to update branch reference '${branch}': ${err.message || ""}`,
      });
    }

    const commitUrl = `https://github.com/${owner}/${repo}/commit/${newCommitSha}`;
    room.githubRepo = {
      owner,
      repo,
      branch,
      repoUrl: `https://github.com/${owner}/${repo}`,
      lastCommitSha: newCommitSha,
      lastCommitUrl: commitUrl,
      lastPushedAt: Date.now(),
    };

    // Mark all files clean relative to GitHub
    for (const [, f] of room.files.entries()) {
      f.originalCode = f.code;
    }

    io.to(room.id).emit("github-repo-linked", room.githubRepo);
    io.to(room.id).emit("files-update", { files: fileListFor(room) });

    logActivity(room, {
      type: "github-push",
      text: `${authorName || "Someone"} pushed commit ${newCommitSha.slice(0, 7)} to ${branch}`,
      path: null,
    });

    io.to(room.id).emit("chat-message", {
      id: uuidv4(),
      userId: "system",
      userName: "GitHub",
      color: "#6FE3A6",
      message: `🚀 ${authorName || "Someone"} pushed commit ${newCommitSha.slice(0, 7)} to ${branch}: "${message || "Update"}"`,
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      commitSha: newCommitSha,
      commitUrl,
      branch,
      filesCount: treeEntries.length,
      githubRepo: room.githubRepo,
      coAuthors: coAuthorTrailers,
    });
  } catch (err) {
    console.error("[github/push] error:", err);
    res.status(500).json({ error: err.message || "Failed to commit and push to GitHub." });
  }
});

/**
 * Pull latest changes from GitHub for a repository into the shared workspace.
 * POST /api/github/pull
 */
app.post("/api/github/pull", async (req, res) => {
  const { roomId, owner: reqOwner, repo: reqRepo, branch: reqBranch, token } = req.body;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  // Check if files are locked by someone
  if (room.fileLocks.size > 0) {
    const lockedFiles = [...room.fileLocks.entries()]
      .map(([p, l]) => `${p} (${l.userName})`)
      .join(", ");
    return res.status(400).json({
      error: `Cannot pull while files are locked by other members: ${lockedFiles}. Please ask them to release their locks first.`,
    });
  }

  const owner = reqOwner || room.githubRepo?.owner;
  const repo = reqRepo || room.githubRepo?.repo;
  let branch = reqBranch || room.githubRepo?.branch || "main";

  if (!owner || !repo) {
    return res.status(400).json({ error: "Repository owner and repo name are required to pull." });
  }

  const headers = {
    "User-Agent": "PairEditor-App",
    Accept: "application/vnd.github.v3+json",
  };
  if (token && token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  try {
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) {
      if (treeRes.status === 404) {
        return res.status(404).json({ error: `Branch '${branch}' or repository '${owner}/${repo}' not found on GitHub.` });
      }
      return res.status(treeRes.status).json({ error: "Failed to fetch repository tree from GitHub." });
    }

    const treeData = await treeRes.json();
    if (!treeData.tree || !Array.isArray(treeData.tree)) {
      return res.status(400).json({ error: "No files found in the specified repository branch." });
    }

    const IGNORED_PREFIXES = ["node_modules/", ".git/", ".vscode/", ".idea/", "dist/", "build/", ".next/", "vendor/"];
    const IGNORED_EXTS = new Set([
      "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "tar", "gz",
      "exe", "dll", "so", "dylib", "mp3", "mp4", "wav", "woff", "woff2", "ttf", "eot",
      "lock", "bin", "pyc", "class", "jar"
    ]);

    const candidateFiles = treeData.tree.filter((item) => {
      if (item.type !== "blob") return false;
      const p = item.path;
      if (IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes("/" + prefix))) return false;
      const ext = p.split(".").pop()?.toLowerCase();
      if (IGNORED_EXTS.has(ext)) return false;
      if (item.size && item.size > 250 * 1024) return false;
      return true;
    }).slice(0, 100);

    const fetchedFiles = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < candidateFiles.length; i += BATCH_SIZE) {
      const batch = candidateFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          try {
            const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${item.sha}`, {
              headers: { ...headers, Accept: "application/vnd.github.raw+json" },
            });
            if (blobRes.ok) {
              const text = await blobRes.text();
              return { path: item.path, content: text, language: guessLanguageFromPath(item.path) };
            }
          } catch (e) {
            console.warn(`[github/pull] Failed blob fetch for ${item.path}:`, e.message);
          }
          return null;
        })
      );
      fetchedFiles.push(...batchResults.filter(Boolean));
    }

    if (fetchedFiles.length === 0) {
      return res.status(500).json({ error: "Failed to download file contents from GitHub." });
    }

    room.files.clear();
    room.lineAuthorsByFile.clear();
    fetchedFiles.forEach(({ path, content, language }) => {
      room.files.set(path, {
        code: content,
        language,
        originalCode: content,
        lastEditedBy: null,
      });
      room.lineAuthorsByFile.set(path, new Map());
    });

    room.githubRepo = {
      owner,
      repo,
      branch,
      repoUrl: `https://github.com/${owner}/${repo}`,
      lastPulledAt: Date.now(),
    };

    io.to(room.id).emit("files-update", { files: fileListFor(room) });
    io.to(room.id).emit("github-repo-linked", room.githubRepo);

    // Refresh each viewer's opened file
    for (const [socketId, activePath] of room.memberActiveFile.entries()) {
      let targetPath = activePath;
      if (!room.files.has(targetPath)) {
        targetPath = fetchedFiles[0].path;
        room.memberActiveFile.set(socketId, targetPath);
      }
      const f = room.files.get(targetPath);
      io.to(socketId).emit("file-opened", {
        path: targetPath,
        code: f.code,
        language: f.language,
        originalCode: f.originalCode ?? null,
        lineAuthors: {},
      });
    }

    logActivity(room, {
      type: "github-pull",
      text: `Pulled latest changes from ${owner}/${repo}@${branch}`,
      path: null,
    });

    io.to(room.id).emit("chat-message", {
      id: uuidv4(),
      userId: "system",
      userName: "GitHub",
      color: "#6FE3A6",
      message: `📥 Pulled ${fetchedFiles.length} files from ${owner}/${repo}@${branch}`,
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      count: fetchedFiles.length,
      owner,
      repo,
      branch,
      githubRepo: room.githubRepo,
    });
  } catch (err) {
    console.error("[github/pull] error:", err);
    res.status(500).json({ error: err.message || "Failed to pull from GitHub." });
  }
});

/**
 * Export current workspace or active file as a GitHub Gist.
 * POST /api/github/gist/export
 */
app.post("/api/github/gist/export", async (req, res) => {
  const { roomId, description, isPublic, token, activeOnly, activePath } = req.body;
  const room = rooms.get(roomId);
  if (!room || !room.files || room.files.size === 0) {
    return res.status(400).json({ error: "No files in workspace to export as Gist." });
  }

  const gistFiles = {};
  if (activeOnly && activePath && room.files.has(activePath)) {
    const f = room.files.get(activePath);
    gistFiles[activePath] = { content: f.code || "// empty file\n" };
  } else {
    for (const [path, f] of room.files.entries()) {
      gistFiles[path.replace(/\//g, "_")] = { content: f.code || "// empty file\n" };
    }
  }

  const headers = {
    "User-Agent": "PairEditor-App",
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
  if (token && token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  try {
    const gistRes = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers,
      body: JSON.stringify({
        description: description || `PairEditor shared room ${roomId} export`,
        public: Boolean(isPublic),
        files: gistFiles,
      }),
    });

    if (!gistRes.ok) {
      const err = await gistRes.json().catch(() => ({}));
      return res.status(gistRes.status).json({ error: err.message || "Failed to create GitHub Gist." });
    }

    const gistData = await gistRes.json();
    res.json({
      success: true,
      gistId: gistData.id,
      htmlUrl: gistData.html_url,
      filesCount: Object.keys(gistFiles).length,
    });
  } catch (err) {
    console.error("[github/gist/export] error:", err);
    res.status(500).json({ error: err.message || "Failed to export to GitHub Gist." });
  }
});

/**
 * Import files from a GitHub Gist into the room workspace.
 * POST /api/github/gist/import
 */
app.post("/api/github/gist/import", async (req, res) => {
  const { roomId, gistId, token } = req.body;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  if (room.fileLocks.size > 0) {
    return res.status(400).json({ error: "Cannot import Gist while files are locked by members." });
  }

  const cleanId = String(gistId || "").trim().replace(/^https?:\/\/gist\.github\.com\/[^\/]+\//i, "").replace(/\/$/, "");
  if (!cleanId) {
    return res.status(400).json({ error: "Invalid Gist ID or URL." });
  }

  const headers = {
    "User-Agent": "PairEditor-App",
    Accept: "application/vnd.github.v3+json",
  };
  if (token && token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  try {
    const gistRes = await fetch(`https://api.github.com/gists/${cleanId}`, { headers });
    if (!gistRes.ok) {
      return res.status(gistRes.status).json({ error: "Failed to fetch GitHub Gist." });
    }

    const gistData = await gistRes.json();
    const fileEntries = Object.values(gistData.files || {});
    if (fileEntries.length === 0) {
      return res.status(400).json({ error: "No files found in this Gist." });
    }

    room.files.clear();
    room.lineAuthorsByFile.clear();

    fileEntries.forEach((f) => {
      const filename = f.filename;
      room.files.set(filename, {
        code: f.content,
        language: guessLanguageFromPath(filename),
        originalCode: f.content,
        lastEditedBy: null,
      });
      room.lineAuthorsByFile.set(filename, new Map());
    });

    io.to(room.id).emit("files-update", { files: fileListFor(room) });

    for (const [socketId] of room.memberActiveFile.entries()) {
      const firstPath = fileEntries[0].filename;
      room.memberActiveFile.set(socketId, firstPath);
      io.to(socketId).emit("file-opened", {
        path: firstPath,
        code: fileEntries[0].content,
        language: guessLanguageFromPath(firstPath),
        originalCode: fileEntries[0].content,
        lineAuthors: {},
      });
    }

    logActivity(room, {
      type: "github-import",
      text: `Imported ${fileEntries.length} files from GitHub Gist`,
      path: null,
    });

    res.json({
      success: true,
      count: fileEntries.length,
      gistUrl: gistData.html_url,
    });
  } catch (err) {
    console.error("[github/gist/import] error:", err);
    res.status(500).json({ error: err.message || "Failed to import GitHub Gist." });
  }
});

// ── Socket.IO connection handler ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── join-room ──────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomId, userName, githubUser }) => {
    socket.join(roomId);
    socket.roomId = roomId;

    const room = getOrCreateRoom(roomId);
    const usedColors = [...room.users.values()].map((u) => u.color);
    const color = pickColor(usedColors);

    const userInfo = {
      id: socket.id,
      name: userName || "Anonymous",
      color,
      cursor: null,
      githubUser: githubUser || null,
    };
    room.users.set(socket.id, userInfo);

    // Pick initial active file for this socket: default to index.js or first file
    const fileKeys = [...room.files.keys()];
    const initialActivePath = fileKeys.length > 0 ? fileKeys[0] : null;
    if (initialActivePath) {
      room.memberActiveFile.set(socket.id, initialActivePath);
    }

    const activeObj = initialActivePath ? room.files.get(initialActivePath) : null;
    const initialBlame = initialActivePath && room.lineAuthorsByFile.has(initialActivePath)
      ? Object.fromEntries(room.lineAuthorsByFile.get(initialActivePath))
      : {};

    console.log(`[room:${roomId}] ${userInfo.name} joined room (viewing: ${initialActivePath})`);

    // Send full room state & recent activities to the joining socket
    socket.emit("room-state", {
      roomId,
      currentUser: userInfo,
      files: fileListFor(room),
      locks: Object.fromEntries(room.fileLocks),
      activeFile: initialActivePath,
      activeFileContent: activeObj ? {
        path: initialActivePath,
        code: activeObj.code,
        language: activeObj.language,
        originalCode: activeObj.originalCode ?? null,
        lineAuthors: initialBlame,
      } : null,
      whiteboard: room.whiteboard || [],
      viewMode: room.viewMode || "code",
      githubRepo: room.githubRepo || null,
      users: getTeamUsers(room),
      activities: room.activities.slice(-50),
    });

    // Notify room of arrival
    socket.to(roomId).emit("user-joined", userInfo);

    const teamUsers = getTeamUsers(room);
    io.to(roomId).emit("users-update", teamUsers);
    io.to(roomId).emit("presence-update", teamUsers);
    io.to(roomId).emit("files-update", { files: fileListFor(room) });

    logActivity(room, {
      type: "user-joined",
      text: `${userInfo.name} joined the room`,
      userId: socket.id,
      userName: userInfo.name,
      color: userInfo.color,
      path: null,
    });
  });

  // ── link-github-user ───────────────────────────────────────────────────────
  socket.on("link-github-user", ({ githubUser }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) {
      user.githubUser = githubUser || null;
      io.to(room.id).emit("users-update", getTeamUsers(room));
    }
  });

  // ── file-open (Per-member active file & Auto write-lock acquisition) ───────
  socket.on("file-open", ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const safePath = String(path).replace(/^\/+/, "");
    if (!room.files.has(safePath)) return;

    const user = room.users.get(socket.id);

    // Auto-release previous lock if user switches away from the locked file
    for (const [existingPath, lock] of room.fileLocks.entries()) {
      if (lock.userId === socket.id && existingPath !== safePath) {
        releaseFileLock(room, existingPath, "switched");
      }
    }

    room.memberActiveFile.set(socket.id, safePath);

    // First-come, first-served write lock (Spec 2 & Spec 7)
    let hasWriteAccess = false;
    const existingLock = room.fileLocks.get(safePath);

    if (!existingLock) {
      if (user) {
        room.fileLocks.set(safePath, {
          userId: socket.id,
          userName: user.name,
          color: user.color,
          lockedAt: Date.now(),
          lastActivityAt: Date.now(),
        });
        scheduleLockTimers(room, safePath);
        hasWriteAccess = true;

        const lockPayload = {
          locks: Object.fromEntries(room.fileLocks),
          files: fileListFor(room),
        };
        io.to(room.id).emit("file-locks-update", lockPayload);
        io.to(room.id).emit("file-locks-updated", lockPayload);

        logActivity(room, {
          type: "lock-acquired",
          text: `${user.name} is editing ${safePath}`,
          userId: socket.id,
          userName: user.name,
          color: user.color,
          path: safePath,
        });
      }
    } else if (existingLock.userId === socket.id) {
      hasWriteAccess = true;
      existingLock.lastActivityAt = Date.now();
      scheduleLockTimers(room, safePath);
    } else {
      hasWriteAccess = false;
    }

    const f = room.files.get(safePath);
    const blame = room.lineAuthorsByFile.has(safePath)
      ? Object.fromEntries(room.lineAuthorsByFile.get(safePath))
      : {};

    // Reply ONLY to requesting socket with full current file content + write access flag
    socket.emit("file-opened", {
      path: safePath,
      code: f.code,
      language: f.language,
      originalCode: f.originalCode ?? null,
      lineAuthors: blame,
      hasWriteAccess,
    });

    // SPEC 7: file-lock-status (to requester only)
    socket.emit("file-lock-status", {
      path: safePath,
      hasWriteAccess,
      ownerName: existingLock ? existingLock.userName : (hasWriteAccess ? user?.name : null),
      ownerColor: existingLock ? existingLock.color : (hasWriteAccess ? user?.color : null),
    });

    if (hasWriteAccess) {
      socket.emit("file-lock-granted", { path: safePath });
    } else if (existingLock) {
      socket.emit("file-lock-denied", {
        path: safePath,
        ownerName: existingLock.userName,
        ownerColor: existingLock.color,
      });
    }

    // Broadcast updated viewer lists for the file tree
    io.to(room.id).emit("files-update", { files: fileListFor(room) });
  });

  // ── file-lock-acquire ──────────────────────────────────────────────────────
  socket.on("file-lock-acquire", ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    const safePath = String(path).replace(/^\/+/, "");
    if (!room.files.has(safePath)) return;

    const existingLock = room.fileLocks.get(safePath);

    if (existingLock) {
      if (existingLock.userId === socket.id) {
        // Already owned by this socket, refresh timers
        existingLock.lastActivityAt = Date.now();
        scheduleLockTimers(room, safePath);
        socket.emit("file-lock-granted", { path: safePath });
        socket.emit("file-lock-status", {
          path: safePath,
          hasWriteAccess: true,
          ownerName: user.name,
          ownerColor: user.color,
        });
        return;
      }
      // Held by someone else -> deny
      socket.emit("file-lock-denied", {
        path: safePath,
        ownerName: existingLock.userName,
        ownerColor: existingLock.color,
      });
      socket.emit("file-lock-status", {
        path: safePath,
        hasWriteAccess: false,
        ownerName: existingLock.userName,
        ownerColor: existingLock.color,
      });
      return;
    }

    // Free! Release any other file lock this socket holds
    releaseUserLocks(room, socket.id);

    // Grant lock
    room.fileLocks.set(safePath, {
      userId: socket.id,
      userName: user.name,
      color: user.color,
      lockedAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    scheduleLockTimers(room, safePath);

    socket.emit("file-lock-granted", { path: safePath });
    socket.emit("file-lock-status", {
      path: safePath,
      hasWriteAccess: true,
      ownerName: user.name,
      ownerColor: user.color,
    });

    const lockPayload = {
      locks: Object.fromEntries(room.fileLocks),
      files: fileListFor(room),
    };
    io.to(room.id).emit("file-locks-update", lockPayload);
    io.to(room.id).emit("file-locks-updated", lockPayload);

    logActivity(room, {
      type: "lock-acquired",
      text: `${user.name} is editing ${safePath}`,
      userId: socket.id,
      userName: user.name,
      color: user.color,
      path: safePath,
    });
  });

  // ── file-lock-release & file-release-lock (Spec 7) ──────────────────────────
  const handleLockRelease = ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;
    const safePath = String(path).replace(/^\/+/, "");
    const lock = room.fileLocks.get(safePath);
    if (lock && lock.userId === socket.id) {
      releaseFileLock(room, safePath, "released");
    }
  };
  socket.on("file-lock-release", handleLockRelease);
  socket.on("file-release-lock", handleLockRelease);

  // ── file-lock-request (Read-only viewer asks owner for edit access) ──────────
  socket.on("file-lock-request", ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    const safePath = String(path).replace(/^\/+/, "");
    const lock = room.fileLocks.get(safePath);
    if (!lock || lock.userId === socket.id) return;

    if (!room.lockRequests.has(safePath)) {
      room.lockRequests.set(safePath, new Map());
    }
    const fileReqs = room.lockRequests.get(safePath);
    if (fileReqs.has(socket.id)) return; // ignore duplicate

    // 30 second timer
    const timer = setTimeout(() => {
      const curReqs = room.lockRequests.get(safePath);
      if (curReqs && curReqs.has(socket.id)) {
        curReqs.delete(socket.id);
        io.to(socket.id).emit("file-lock-request-expired", { path: safePath });
      }
    }, 30 * 1000);

    fileReqs.set(socket.id, {
      timer,
      fromUserName: user.name,
      fromColor: user.color,
    });

    // Notify lock owner
    io.to(lock.userId).emit("file-lock-request-received", {
      path: safePath,
      fromUserId: socket.id,
      fromUserName: user.name,
      fromColor: user.color,
    });

    socket.emit("file-lock-request-sent", { path: safePath });
  });

  // ── file-lock-respond (Owner grants or declines request) ────────────────────
  socket.on("file-lock-respond", ({ path, fromUserId, accept }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path || !fromUserId) return;

    const safePath = String(path).replace(/^\/+/, "");
    const lock = room.fileLocks.get(safePath);
    if (!lock || lock.userId !== socket.id) return;

    const fileReqs = room.lockRequests.get(safePath);
    if (fileReqs && fileReqs.has(fromUserId)) {
      const req = fileReqs.get(fromUserId);
      clearTimeout(req.timer);
      fileReqs.delete(fromUserId);
    }

    const requesterUser = room.users.get(fromUserId);
    if (!requesterUser) return;

    if (!accept) {
      io.to(fromUserId).emit("file-lock-request-declined", {
        path: safePath,
        byUserName: lock.userName,
      });
      return;
    }

    // Accepted: release current owner's lock and transfer to requester
    clearLockTimers(room, safePath);
    releaseUserLocks(room, fromUserId);

    room.fileLocks.set(safePath, {
      userId: fromUserId,
      userName: requesterUser.name,
      color: requesterUser.color,
      lockedAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    scheduleLockTimers(room, safePath);

    io.to(fromUserId).emit("file-lock-granted", { path: safePath });
    io.to(fromUserId).emit("file-lock-status", {
      path: safePath,
      hasWriteAccess: true,
      ownerName: requesterUser.name,
      ownerColor: requesterUser.color,
    });
    socket.emit("file-lock-transferred", { path: safePath, toUserName: requesterUser.name });
    socket.emit("file-lock-status", {
      path: safePath,
      hasWriteAccess: false,
      ownerName: requesterUser.name,
      ownerColor: requesterUser.color,
    });

    const transferPayload = {
      locks: Object.fromEntries(room.fileLocks),
      files: fileListFor(room),
    };
    io.to(room.id).emit("file-locks-update", transferPayload);
    io.to(room.id).emit("file-locks-updated", transferPayload);

    logActivity(room, {
      type: "lock-transferred",
      text: `${lock.userName} transferred edit access for ${safePath} to ${requesterUser.name}`,
      userId: fromUserId,
      userName: requesterUser.name,
      color: requesterUser.color,
      path: safePath,
    });
  });

  // ── code-change (Only accepted from lock owner) ────────────────────────────
  socket.on("code-change", ({ path, code }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const safePath = String(path).replace(/^\/+/, "");
    const fileObj = room.files.get(safePath);
    if (!fileObj) return;

    const lock = room.fileLocks.get(safePath);
    if (!lock || lock.userId !== socket.id) {
      socket.emit("file-edit-rejected", {
        path: safePath,
        reason: "You do not have write permission for this file.",
      });
      return;
    }

    // Refresh lock activity
    lock.lastActivityAt = Date.now();
    scheduleLockTimers(room, safePath);

    const oldCode = fileObj.code;
    fileObj.code = code;
    fileObj.lastEditedBy = {
      name: lock.userName,
      timestamp: Date.now(),
    };

    // Batch rapid typing: 1 activity event per file per 10 seconds
    const debounceKey = `${socket.id}:${safePath}`;
    const now = Date.now();
    const deb = room.typingDebounce.get(debounceKey) || { lastTime: 0, count: 0 };
    if (now - deb.lastTime > 10000) {
      const oldLines = (oldCode || "").split("\n").length;
      const newLines = (code || "").split("\n").length;
      const diff = Math.abs(newLines - oldLines);
      const detail = diff > 0 ? ` (${diff} lines changed)` : "";
      logActivity(room, {
        type: "code-change",
        text: `${lock.userName} edited ${safePath}${detail}`,
        userId: socket.id,
        userName: lock.userName,
        color: lock.color,
        path: safePath,
      });
      room.typingDebounce.set(debounceKey, { lastTime: now, count: 1 });
    }

    // Broadcast content update to everyone who is CURRENTLY viewing this file
    for (const [otherSocketId, activePath] of room.memberActiveFile.entries()) {
      if (activePath === safePath && otherSocketId !== socket.id) {
        io.to(otherSocketId).emit("file-content-update", {
          path: safePath,
          code,
          senderId: socket.id,
          senderName: lock.userName,
          senderColor: lock.color,
        });
      }
    }
  });

  // ── line-author-update (Blame annotations, accepted from lock owner) ────────
  socket.on("line-author-update", ({ path, lines }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path || !Array.isArray(lines)) return;

    const safePath = String(path).replace(/^\/+/, "");
    const lock = room.fileLocks.get(safePath);
    if (!lock || lock.userId !== socket.id) return;

    if (!room.lineAuthorsByFile.has(safePath)) {
      room.lineAuthorsByFile.set(safePath, new Map());
    }
    const fileBlame = room.lineAuthorsByFile.get(safePath);

    lines.forEach((entry) => {
      fileBlame.set(entry.line, {
        name: entry.name,
        color: entry.color,
        userId: entry.userId,
      });
    });

    for (const [otherSocketId, activePath] of room.memberActiveFile.entries()) {
      if (activePath === safePath && otherSocketId !== socket.id) {
        io.to(otherSocketId).emit("line-author-update", { path: safePath, lines });
      }
    }
  });

  // ── cursor-move (Owner cursor broadcast to viewers of same file) ───────────
  socket.on("cursor-move", ({ path, cursor }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const safePath = String(path).replace(/^\/+/, "");
    const user = room.users.get(socket.id);
    if (user) user.cursor = cursor;

    for (const [otherSocketId, activePath] of room.memberActiveFile.entries()) {
      if (activePath === safePath && otherSocketId !== socket.id) {
        io.to(otherSocketId).emit("cursor-update", {
          path: safePath,
          userId: socket.id,
          cursor,
        });
      }
    }
  });

  // ── typing indicator ───────────────────────────────────────────────────────
  socket.on("typing-start", ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const safePath = String(path || "").replace(/^\/+/, "");
    for (const [otherSocketId, activePath] of room.memberActiveFile.entries()) {
      if (activePath === safePath && otherSocketId !== socket.id) {
        io.to(otherSocketId).emit("user-typing", { userId: socket.id, path: safePath });
      }
    }
  });

  socket.on("typing-stop", ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const safePath = String(path || "").replace(/^\/+/, "");
    for (const [otherSocketId, activePath] of room.memberActiveFile.entries()) {
      if (activePath === safePath && otherSocketId !== socket.id) {
        io.to(otherSocketId).emit("user-stopped-typing", { userId: socket.id, path: safePath });
      }
    }
  });

  // ── create-file ────────────────────────────────────────────────────────────
  socket.on("create-file", ({ path, code, language }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const user = room.users.get(socket.id);
    const safePath = String(path).replace(/^\/+/, "");

    if (room.files.has(safePath)) {
      socket.emit("create-file-error", { message: `"${safePath}" already exists.` });
      return;
    }

    const fileLang = language || guessLanguageFromPath(safePath);
    room.files.set(safePath, {
      code: code || "",
      language: fileLang,
      originalCode: null,
      lastEditedBy: user ? { name: user.name, timestamp: Date.now() } : null,
    });
    room.lineAuthorsByFile.set(safePath, new Map());

    // Switch creator to this file and grant lock automatically
    room.memberActiveFile.set(socket.id, safePath);
    releaseUserLocks(room, socket.id);

    if (user) {
      room.fileLocks.set(safePath, {
        userId: socket.id,
        userName: user.name,
        color: user.color,
        lockedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      scheduleLockTimers(room, safePath);
    }

    io.to(room.id).emit("files-update", { files: fileListFor(room) });
    io.to(room.id).emit("file-locks-update", {
      locks: Object.fromEntries(room.fileLocks),
      files: fileListFor(room),
    });

    socket.emit("file-opened", {
      path: safePath,
      code: code || "",
      language: fileLang,
      originalCode: null,
      lineAuthors: {},
    });
    socket.emit("file-lock-granted", { path: safePath });

    logActivity(room, {
      type: "create-file",
      text: `${user?.name || "Someone"} created ${safePath}`,
      userId: socket.id,
      userName: user?.name,
      color: user?.color,
      path: safePath,
    });
  });

  // ── rename-file ────────────────────────────────────────────────────────────
  socket.on("rename-file", ({ oldPath, newPath }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !oldPath || !newPath) return;

    const user = room.users.get(socket.id);
    const oldSafe = String(oldPath).replace(/^\/+/, "");
    const newSafe = String(newPath).replace(/^\/+/, "");

    if (oldSafe === newSafe) return;
    if (!room.files.has(oldSafe)) return;

    if (room.files.has(newSafe)) {
      socket.emit("rename-file-error", { message: `A file named "${newSafe}" already exists.` });
      return;
    }

    // Check lock: blocked if locked by someone else
    const lock = room.fileLocks.get(oldSafe);
    if (lock && lock.userId !== socket.id) {
      socket.emit("file-operation-blocked", {
        message: `Cannot rename: "${oldSafe}" is currently locked by ${lock.userName}.`,
      });
      return;
    }

    const fileEntry = room.files.get(oldSafe);
    fileEntry.language = guessLanguageFromPath(newSafe);
    room.files.delete(oldSafe);
    room.files.set(newSafe, fileEntry);

    const blame = room.lineAuthorsByFile.get(oldSafe);
    if (blame) {
      room.lineAuthorsByFile.set(newSafe, blame);
      room.lineAuthorsByFile.delete(oldSafe);
    }

    if (lock) {
      clearLockTimers(room, oldSafe);
      room.fileLocks.delete(oldSafe);
      room.fileLocks.set(newSafe, lock);
      scheduleLockTimers(room, newSafe);
    }

    // Migrate any viewers of oldSafe to newSafe
    for (const [sId, p] of room.memberActiveFile.entries()) {
      if (p === oldSafe) {
        room.memberActiveFile.set(sId, newSafe);
        io.to(sId).emit("file-renamed", { oldPath: oldSafe, newPath: newSafe });
      }
    }

    io.to(room.id).emit("files-update", { files: fileListFor(room) });
    io.to(room.id).emit("file-locks-update", {
      locks: Object.fromEntries(room.fileLocks),
      files: fileListFor(room),
    });

    logActivity(room, {
      type: "rename-file",
      text: `${user?.name || "Someone"} renamed ${oldSafe} to ${newSafe}`,
      userId: socket.id,
      userName: user?.name,
      color: user?.color,
      path: newSafe,
    });
  });

  // ── delete-file ────────────────────────────────────────────────────────────
  socket.on("delete-file", ({ path }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !path) return;

    const user = room.users.get(socket.id);
    const safePath = String(path).replace(/^\/+/, "");
    if (!room.files.has(safePath)) return;

    // Block if locked by someone else
    const lock = room.fileLocks.get(safePath);
    if (lock && lock.userId !== socket.id) {
      socket.emit("file-operation-blocked", {
        message: `Cannot delete: "${safePath}" is currently locked by ${lock.userName}.`,
      });
      return;
    }

    releaseFileLock(room, safePath, "deleted");
    room.files.delete(safePath);
    room.lineAuthorsByFile.delete(safePath);

    // Pick next available file for any member currently viewing the deleted file
    const remainingFiles = [...room.files.keys()];
    const nextPath = remainingFiles.length > 0 ? remainingFiles[0] : null;

    for (const [sId, p] of room.memberActiveFile.entries()) {
      if (p === safePath) {
        room.memberActiveFile.set(sId, nextPath);
        const nextObj = nextPath ? room.files.get(nextPath) : null;
        io.to(sId).emit("file-deleted", {
          path: safePath,
          nextPath,
          nextFile: nextObj ? {
            path: nextPath,
            code: nextObj.code,
            language: nextObj.language,
            originalCode: nextObj.originalCode ?? null,
            lineAuthors: Object.fromEntries(room.lineAuthorsByFile.get(nextPath) || []),
          } : null,
        });
      }
    }

    io.to(room.id).emit("files-update", { files: fileListFor(room) });
    io.to(room.id).emit("file-locks-update", {
      locks: Object.fromEntries(room.fileLocks),
      files: fileListFor(room),
    });

    logActivity(room, {
      type: "delete-file",
      text: `${user?.name || "Someone"} deleted ${safePath}`,
      userId: socket.id,
      userName: user?.name,
      color: user?.color,
      path: safePath,
    });
  });

  // ── upload-folder ──────────────────────────────────────────────────────────
  socket.on("upload-folder", ({ files }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !Array.isArray(files) || !files.length) return;

    const user = room.users.get(socket.id);

    // Block if any file being overwritten is locked by another user
    for (const f of files) {
      const lock = room.fileLocks.get(f.path);
      if (lock && lock.userId !== socket.id) {
        socket.emit("file-operation-blocked", {
          message: `Cannot upload: "${f.path}" is locked by ${lock.userName}.`,
        });
        return;
      }
    }

    files.forEach(({ path, content, language }) => {
      room.files.set(path, {
        code: content,
        language: language || guessLanguageFromPath(path),
        originalCode: null,
        lastEditedBy: user ? { name: user.name, timestamp: Date.now() } : null,
      });
      if (!room.lineAuthorsByFile.has(path)) {
        room.lineAuthorsByFile.set(path, new Map());
      }
    });

    // If socket had no active file, set to first uploaded file
    let currentActive = room.memberActiveFile.get(socket.id);
    if (!currentActive || !room.files.has(currentActive)) {
      currentActive = files[0].path;
      room.memberActiveFile.set(socket.id, currentActive);
      const f = room.files.get(currentActive);
      socket.emit("file-opened", {
        path: currentActive,
        code: f.code,
        language: f.language,
        originalCode: null,
        lineAuthors: {},
      });
    }

    io.to(room.id).emit("files-update", { files: fileListFor(room) });

    logActivity(room, {
      type: "upload-folder",
      text: `${user?.name || "Someone"} uploaded ${files.length} files`,
      userId: socket.id,
      userName: user?.name,
      color: user?.color,
      path: null,
    });
  });

  // ── Team Chat ──────────────────────────────────────────────────────────────
  socket.on("chat-message", (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    const message = typeof data === "string" ? data : (data?.message || "");
    const audioUrl = typeof data === "object" ? data?.audioUrl : null;
    const duration = typeof data === "object" ? data?.duration : null;
    const payload = {
      id: uuidv4(),
      userId: socket.id,
      userName: user?.name || "Anonymous",
      color: user?.color || "#fff",
      message: message || (audioUrl ? "🎤 Voice message" : ""),
      audioUrl: audioUrl || null,
      duration: duration || null,
      timestamp: Date.now(),
    };
    io.to(room.id).emit("chat-message", payload);
  });

  // ── Shared Whiteboard events (unlocked, free-for-all) ──────────────────────
  socket.on("whiteboard-update", ({ elements }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.whiteboard = Array.isArray(elements) ? elements : [];
    socket.to(room.id).emit("whiteboard-update", { elements: room.whiteboard });
  });

  socket.on("whiteboard-draw-step", ({ stroke }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    socket.to(room.id).emit("whiteboard-draw-step", { stroke, userId: socket.id });
  });

  socket.on("whiteboard-cursor", ({ cursor }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    socket.to(room.id).emit("whiteboard-cursor-update", {
      userId: socket.id,
      userName: user?.name || "Peer",
      color: user?.color || "#6FE3A6",
      cursor,
    });
  });

  socket.on("whiteboard-clear", () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.whiteboard = [];
    io.to(room.id).emit("whiteboard-update", { elements: [] });
  });

  // ── View Mode Change ───────────────────────────────────────────────────────
  socket.on("view-mode-change", ({ viewMode }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.viewMode = viewMode;
    const user = room.users.get(socket.id);
    io.to(room.id).emit("view-mode-update", {
      viewMode,
      senderName: user?.name || "Peer",
      senderId: socket.id,
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    console.log(`[-] Socket disconnected: ${socket.id} from room ${roomId}`);

    // Release any lock held by this user
    releaseUserLocks(room, socket.id);

    // Clear any pending requests involving this user
    for (const [path, reqMap] of room.lockRequests.entries()) {
      if (reqMap.has(socket.id)) {
        clearTimeout(reqMap.get(socket.id).timer);
        reqMap.delete(socket.id);
      }
    }

    room.memberActiveFile.delete(socket.id);
    room.users.delete(socket.id);

    socket.to(roomId).emit("user-left", { userId: socket.id });
    const teamUsers = getTeamUsers(room);
    io.to(roomId).emit("users-update", teamUsers);
    io.to(roomId).emit("presence-update", teamUsers);
    io.to(roomId).emit("files-update", { files: fileListFor(room) });

    if (user) {
      logActivity(room, {
        type: "user-left",
        text: `${user.name} left the room`,
        userId: socket.id,
        userName: user.name,
        color: user.color,
        path: null,
      });
    }

    // Clean up empty rooms immediately when last user leaves
    if (room.users.size === 0) {
      // Clear any pending timers
      for (const [, timers] of room.lockTimeouts.entries()) {
        if (timers.warnTimer) clearTimeout(timers.warnTimer);
        if (timers.expireTimer) clearTimeout(timers.expireTimer);
      }
      rooms.delete(roomId);
      roomFileLocks.delete(roomId);
      console.log(`[room:${roomId}] deleted (last user left)`);
    }
  });
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 PairEditor server running on http://localhost:${PORT}\n`);
});
