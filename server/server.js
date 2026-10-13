/**
 * PairEditor – Real-time Collaborative Code Editor
 * Backend: Express + Socket.IO
 *
 * Architecture overview:
 *  - Team Rooms: provide presence (members joined with roomId) and team chat.
 *  - Workspaces: hold code, files, activeFile, line blame, whiteboard, viewMode.
 *      - Personal workspaces ("personal:<socketId>"): private to each user by default.
 *      - Session workspaces ("session:<uuid>"): shared collaborative workspaces created
 *        when users request and accept collaboration.
 *  - Sockets join "ws:<workspaceId>" to receive scoped editor & whiteboard events.
 *  - Team chat and presence broadcast to the entire team room.
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
  // Keep-alive tuning to avoid phantom disconnects
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── In-memory stores ────────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, { users: Map<socketId, userInfo> }>
 * userInfo: { id, name, color, cursor, workspaceId, workspaceType, sessionId }
 */
const rooms = new Map();

/**
 * workspaces: Map<workspaceId, workspaceState>
 * workspaceState: {
 *   id,
 *   type: "personal" | "session",
 *   code,
 *   language,
 *   files: Map<path, { code, language }>,
 *   activeFile,
 *   lineAuthors: Map<lineNumber, { name, color, userId }>,
 *   lineAuthorsByFile: Map<path, Map<lineNumber, authorInfo>>,
 *   whiteboard: Array,
 *   viewMode: "code" | "split" | "whiteboard",
 *   members: Set<socketId>
 * }
 */
const workspaces = new Map();

/**
 * pendingCollabRequests: Map<`${fromUserId}->${toUserId}`, { fromUserId, toUserId, timestamp, timer }>
 */
const pendingCollabRequests = new Map();

/**
 * Resolves and clears a pending collab request.
 * Clears timeout, deletes from Map, and notifies the sender with `collab-request-resolved`.
 */
function resolvePendingRequest(reqKey, status) {
  const req = pendingCollabRequests.get(reqKey);
  if (!req) return;
  if (req.timer) clearTimeout(req.timer);
  pendingCollabRequests.delete(reqKey);

  // Notify sender
  io.to(req.fromUserId).emit("collab-request-resolved", {
    fromUserId: req.fromUserId,
    toUserId: req.toUserId,
    status, // "accepted" | "declined" | "cancelled" | "expired"
  });
}

/** Clear all pending requests involving a user (as sender or target) */
function clearPendingRequestsForUser(userId, status = "cancelled") {
  for (const [key, req] of pendingCollabRequests.entries()) {
    if (req.fromUserId === userId) {
      // User was sender: cancel popup on target
      io.to(req.toUserId).emit("collab-request-cancelled", { fromUserId: userId });
      resolvePendingRequest(key, status);
    } else if (req.toUserId === userId) {
      // User was target: cancel popup on user, resolve for sender
      io.to(req.toUserId).emit("collab-request-cancelled", { fromUserId: req.fromUserId });
      resolvePendingRequest(key, status);
    }
  }
}

/** Predefined user colours so each visitor gets a unique accent */
const USER_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57",
  "#FF9FF3", "#54A0FF", "#5F27CD", "#00D2D3", "#FF9F43",
  "#48DBFB", "#1DD1A1", "#F368E0", "#EE5A24", "#009432",
];

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
    });
  }
  return rooms.get(roomId);
}

/** Create a fresh personal workspace for a socket */
function createPersonalWorkspace(socketId) {
  return {
    id: `personal:${socketId}`,
    type: "personal",
    code: "// Start coding here...\n",
    language: "javascript",
    files: new Map(),
    activeFile: null,
    lineAuthors: new Map(),
    lineAuthorsByFile: new Map(),
    whiteboard: [],
    viewMode: "code",
    members: new Set([socketId]),
    githubRepo: null,
  };
}

/** Deep clone a workspace state to initialise a shared session */
function cloneWorkspaceForSession(sourceWs, sessionWsId) {
  const newFiles = new Map();
  if (sourceWs?.files) {
    sourceWs.files.forEach((fileObj, path) => {
      newFiles.set(path, {
        code: fileObj.code,
        language: fileObj.language,
        originalCode: fileObj.originalCode !== undefined ? String(fileObj.originalCode) : undefined,
      });
    });
  }

  const newLineAuthorsByFile = new Map();
  if (sourceWs?.lineAuthorsByFile) {
    sourceWs.lineAuthorsByFile.forEach((blameMap, path) => {
      newLineAuthorsByFile.set(path, new Map(blameMap));
    });
  }

  return {
    id: sessionWsId,
    type: "session",
    code: sourceWs?.code ?? "// Start coding here...\n",
    language: sourceWs?.language ?? "javascript",
    files: newFiles,
    activeFile: sourceWs?.activeFile ?? null,
    lineAuthors: new Map(sourceWs?.lineAuthors ?? []),
    lineAuthorsByFile: newLineAuthorsByFile,
    whiteboard: JSON.parse(JSON.stringify(sourceWs?.whiteboard || [])),
    viewMode: sourceWs?.viewMode ?? "code",
    members: new Set(),
    githubRepo: sourceWs?.githubRepo ? { ...sourceWs.githubRepo } : null,
  };
}

/** Serialise a workspace's file list (path + language + isModified) */
function fileListFor(ws) {
  if (!ws || !ws.files) return [];
  return [...ws.files.keys()].map((path) => {
    const f = ws.files.get(path);
    const currentCode = ws.activeFile === path ? ws.code : f.code;
    return {
      path,
      language: f.language,
      isModified: Boolean(f?.originalCode !== undefined && f?.originalCode !== currentCode),
    };
  });
}

/** Format full workspace payload to send to clients */
function workspaceStatePayload(ws) {
  const activeObj = ws.activeFile && ws.files ? ws.files.get(ws.activeFile) : null;
  return {
    workspaceId: ws.id,
    workspaceType: ws.type,
    code: ws.code,
    language: ws.language,
    originalCode: activeObj?.originalCode ?? null,
    lineAuthors: Object.fromEntries(ws.lineAuthors),
    files: fileListFor(ws),
    activeFile: ws.activeFile,
    whiteboard: ws.whiteboard || [],
    viewMode: ws.viewMode || "code",
    githubRepo: ws.githubRepo || null,
  };
}

/** Format team users list for room presence */
function getTeamUsers(room) {
  if (!room || !room.users) return [];
  return [...room.users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    color: u.color,
    cursor: u.cursor,
    workspaceId: u.workspaceId,
    workspaceType: u.workspaceType || "personal",
    sessionId: u.sessionId || null,
  }));
}

/** Format session member list */
function getSessionMembers(sessionWs, room) {
  if (!sessionWs || !room) return [];
  const list = [];
  for (const socketId of sessionWs.members) {
    const u = room.users.get(socketId);
    if (u) {
      list.push({ id: u.id, name: u.name, color: u.color });
    }
  }
  return list;
}

/** Resolve and validate the workspace for a socket */
function getSocketWorkspace(socket) {
  if (!socket?.workspaceId) return null;
  const ws = workspaces.get(socket.workspaceId);
  if (!ws || !ws.members.has(socket.id)) return null;
  return ws;
}

/** Deep clone a workspace state to create a private workspace for a user leaving a session */
function cloneWorkspaceForPersonal(sourceWs, personalWsId) {
  if (sourceWs?.activeFile && sourceWs?.files?.has(sourceWs.activeFile)) {
    sourceWs.files.get(sourceWs.activeFile).code = sourceWs.code;
  }

  const newFiles = new Map();
  if (sourceWs?.files) {
    sourceWs.files.forEach((fileObj, path) => {
      newFiles.set(path, {
        code: String(fileObj.code ?? ""),
        language: fileObj.language || "plaintext",
        originalCode: fileObj.originalCode !== undefined ? String(fileObj.originalCode) : undefined,
      });
    });
  }

  const newLineAuthorsByFile = new Map();
  if (sourceWs?.lineAuthorsByFile) {
    sourceWs.lineAuthorsByFile.forEach((blameMap, path) => {
      newLineAuthorsByFile.set(path, new Map(blameMap));
    });
  }

  let clonedWhiteboard = [];
  try {
    clonedWhiteboard = structuredClone(sourceWs?.whiteboard || []);
  } catch {
    clonedWhiteboard = JSON.parse(JSON.stringify(sourceWs?.whiteboard || []));
  }

  const socketId = personalWsId.replace("personal:", "");

  return {
    id: personalWsId,
    type: "personal",
    code: String(sourceWs?.code ?? "// Start coding here...\n"),
    language: sourceWs?.language ?? "javascript",
    files: newFiles,
    activeFile: sourceWs?.activeFile ?? null,
    lineAuthors: new Map(sourceWs?.lineAuthors ?? []),
    lineAuthorsByFile: newLineAuthorsByFile,
    whiteboard: clonedWhiteboard,
    viewMode: sourceWs?.viewMode ?? "code",
    members: new Set([socketId]),
    githubRepo: sourceWs?.githubRepo ? { ...sourceWs.githubRepo } : null,
  };
}

/** Remove a socket from a session workspace, notify peers, and dissolve session if 0 or 1 members remain */
function removeSocketFromSession(socket, sessionWs, room) {
  if (!sessionWs || sessionWs.type !== "session") return;

  if (sessionWs.activeFile && sessionWs.files.has(sessionWs.activeFile)) {
    sessionWs.files.get(sessionWs.activeFile).code = sessionWs.code;
  }

  sessionWs.members.delete(socket.id);
  socket.leave(`ws:${sessionWs.id}`);

  // Clear any pending requests involving the leaving user
  clearPendingRequestsForUser(socket.id, "cancelled");

  const user = room?.users.get(socket.id);
  socket.to(`ws:${sessionWs.id}`).emit("session-member-left", {
    userId: socket.id,
    userName: user?.name || "A member",
  });

  // If only 1 member remains in the session, move that member to a private workspace too
  if (sessionWs.members.size === 1) {
    const remainingSocketId = [...sessionWs.members][0];
    const remainingSocket = io.sockets.sockets.get(remainingSocketId);
    const remainingUser = room?.users.get(remainingSocketId);

    // Clear any pending requests involving the remaining user
    clearPendingRequestsForUser(remainingSocketId, "cancelled");

    const remainingPersonalWsId = `personal:${remainingSocketId}`;
    const remainingPersonalWs = cloneWorkspaceForPersonal(sessionWs, remainingPersonalWsId);
    workspaces.set(remainingPersonalWsId, remainingPersonalWs);

    if (remainingSocket) {
      remainingSocket.leave(`ws:${sessionWs.id}`);
      remainingSocket.join(`ws:${remainingPersonalWsId}`);
      remainingSocket.workspaceId = remainingPersonalWsId;

      remainingSocket.emit("workspace-state", workspaceStatePayload(remainingPersonalWs));
      remainingSocket.emit("session-ended", {
        reason: "solo",
        message: "Session ended, you are now working solo",
      });
      remainingSocket.emit("session-update", {
        sessionId: null,
        members: [],
      });
    }

    if (remainingUser) {
      remainingUser.workspaceId = remainingPersonalWsId;
      remainingUser.workspaceType = "personal";
      remainingUser.sessionId = null;
    }

    workspaces.delete(sessionWs.id);
    console.log(`[session:${sessionWs.id}] dissolved (only 1 member remained, moved to solo)`);
  } else if (sessionWs.members.size > 1) {
    const sessionId = sessionWs.id.replace("session:", "");
    io.to(`ws:${sessionWs.id}`).emit("session-update", {
      sessionId,
      members: getSessionMembers(sessionWs, room),
    });
  } else {
    // 0 members remain
    workspaces.delete(sessionWs.id);
    console.log(`[session:${sessionWs.id}] deleted (0 members left)`);
  }
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

function pickColor(usedColors) {
  for (const c of USER_COLORS) {
    if (!usedColors.includes(c)) return c;
  }
  return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
}

// ── REST helpers ─────────────────────────────────────────────────────────────
/** Generate a fresh room ID so the client can redirect to it */
app.get("/api/room/new", (_req, res) => {
  const roomId = uuidv4().slice(0, 8);
  res.json({ roomId });
});

/** Health check */
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

/**
 * Download everything uploaded to a workspace as a .zip.
 * Accepts ?workspaceId= to download personal or session files.
 * Streams directly from memory — no temp files on disk.
 */
app.get("/api/room/:roomId/download", (req, res) => {
  const { roomId } = req.params;
  const { workspaceId } = req.query;
  const room = rooms.get(roomId);

  let targetWs = null;
  if (workspaceId && workspaces.has(workspaceId)) {
    targetWs = workspaces.get(workspaceId);
  } else if (room) {
    // Fallback: look for the first workspace belonging to this room with files
    for (const [, ws] of workspaces.entries()) {
      if (ws.files && ws.files.size > 0) {
        targetWs = ws;
        break;
      }
    }
  }

  if (!targetWs || targetWs.files.size === 0) {
    return res.status(404).json({ error: "No files uploaded to download." });
  }

  // Make sure the currently active file reflects the latest live edits
  if (targetWs.activeFile && targetWs.files.has(targetWs.activeFile)) {
    targetWs.files.get(targetWs.activeFile).code = targetWs.code;
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

  targetWs.files.forEach(({ code }, path) => {
    archive.append(code ?? "", { name: path });
  });

  archive.finalize();
});

// ── GitHub Integration Endpoints ─────────────────────────────────────────────
/** Parse a GitHub repo URL or shorthand into { owner, repo, branch } */
function parseGitHubUrl(input) {
  if (!input) return null;
  let str = input.trim().replace(/\.git$/, "");
  // Format: https://github.com/owner/repo/tree/branch
  const treeMatch = str.match(/github\.com\/([^\/]+)\/([^\/]+)\/tree\/(.+)/i);
  if (treeMatch) {
    return { owner: treeMatch[1], repo: treeMatch[2], branch: treeMatch[3] };
  }
  // Format: https://github.com/owner/repo
  const urlMatch = str.match(/github\.com\/([^\/]+)\/([^\/]+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], branch: null };
  }
  // Format: owner/repo
  const slashMatch = str.match(/^([^\/]+)\/([^\/]+)$/);
  if (slashMatch) {
    return { owner: slashMatch[1], repo: slashMatch[2], branch: null };
  }
  return null;
}

/**
 * Import a GitHub repository into the active workspace.
 * POST /api/github/import
 * Body: { roomId, workspaceId, repoUrl, branch, token }
 */
app.post("/api/github/import", async (req, res) => {
  const { roomId, workspaceId, repoUrl, branch: reqBranch, token } = req.body;
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return res.status(400).json({
      error: "Invalid repository format. Please enter 'owner/repo' (e.g. facebook/react) or full GitHub URL.",
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
    // 1. Resolve default branch if not specified
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

    // 2. Fetch recursive git tree
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
    if (!treeRes.ok) {
      return res.status(treeRes.status).json({
        error: `Could not fetch branch '${branch}' for ${owner}/${repo}. Check if the branch name is correct.`,
      });
    }
    const treeData = await treeRes.json();
    if (!treeData.tree || !Array.isArray(treeData.tree)) {
      return res.status(400).json({ error: "No files found in the specified repository branch." });
    }

    // 3. Filter files: Keep text files, skip binary/node_modules/.git/dist
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
      // Skip files larger than 250KB to keep the collaborative editor blazing fast
      if (item.size && item.size > 250 * 1024) return false;
      return true;
    }).slice(0, 100); // Up to 100 source code files

    if (candidateFiles.length === 0) {
      return res.status(400).json({ error: "No editable source code files found in repository." });
    }

    // 4. Resolve target workspace
    let targetWs = null;
    if (workspaceId && workspaces.has(workspaceId)) {
      targetWs = workspaces.get(workspaceId);
    } else {
      for (const [, ws] of workspaces.entries()) {
        targetWs = ws;
        break;
      }
    }
    if (!targetWs) {
      return res.status(404).json({ error: "Target workspace not found." });
    }

    // 5. Download file contents in parallel batches of 10
    const fetchedFiles = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < candidateFiles.length; i += BATCH_SIZE) {
      const batch = candidateFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          try {
            const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${item.sha}`, {
              headers: { ...headers, "Accept": "application/vnd.github.raw+json" },
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

    // 6. Update target workspace files
    targetWs.files = new Map();
    fetchedFiles.forEach(({ path, content, language }) => {
      targetWs.files.set(path, { code: content, language, originalCode: content });
    });

    // Select suitable default active file
    const preferredFiles = ["README.md", "src/App.jsx", "src/App.js", "src/index.js", "src/main.jsx", "index.html", "index.js", "package.json"];
    const foundPref = preferredFiles.find((p) => targetWs.files.has(p));
    targetWs.activeFile = foundPref || fetchedFiles[0].path;

    const activeObj = targetWs.files.get(targetWs.activeFile);
    targetWs.code = activeObj.code;
    targetWs.language = activeObj.language;
    targetWs.lineAuthors = new Map();
    targetWs.githubRepo = {
      owner,
      repo,
      branch,
      repoUrl: `https://github.com/${owner}/${repo}`,
      importedAt: Date.now(),
    };

    // 7. Emit updates to workspace members
    io.to(`ws:${targetWs.id}`).emit("files-update", {
      files: fileListFor(targetWs),
      activeFile: targetWs.activeFile,
    });
    io.to(`ws:${targetWs.id}`).emit("active-file-changed", {
      path: targetWs.activeFile,
      code: targetWs.code,
      language: targetWs.language,
      originalCode: activeObj.originalCode ?? null,
      lineAuthors: {},
    });
    io.to(`ws:${targetWs.id}`).emit("github-repo-linked", targetWs.githubRepo);

    // Broadcast room notification
    if (roomId) {
      io.to(roomId).emit("chat-message", {
        id: uuidv4(),
        userId: "system",
        userName: "GitHub",
        color: "#6FE3A6",
        message: `📦 Imported ${fetchedFiles.length} files from ${owner}/${repo}@${branch}`,
        timestamp: Date.now(),
      });
    }

    res.json({
      success: true,
      count: fetchedFiles.length,
      owner,
      repo,
      branch,
      activeFile: targetWs.activeFile,
      githubRepo: targetWs.githubRepo,
    });
  } catch (err) {
    console.error("[github/import] error:", err);
    res.status(500).json({ error: err.message || "Failed to import from GitHub." });
  }
});

/**
 * Commit and push current workspace files to GitHub using Git Data API.
 * POST /api/github/push
 * Body: { roomId, workspaceId, owner, repo, branch, createBranch, message, token, authorName, authorEmail }
 */
app.post("/api/github/push", async (req, res) => {
  const {
    roomId,
    workspaceId,
    owner,
    repo,
    branch,
    createBranch,
    message,
    token,
    authorName,
    authorEmail,
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

  const clientCode = req.body.code;
  const clientActiveFile = req.body.activeFile || "index.html";

  let targetWs = null;
  if (workspaceId && workspaces.has(workspaceId)) {
    targetWs = workspaces.get(workspaceId);
  } else {
    // 1. Look for any workspace that has files
    for (const [, ws] of workspaces.entries()) {
      if (ws.files && ws.files.size > 0) {
        targetWs = ws;
        break;
      }
    }
    // 2. Check room members if roomId is provided
    if (!targetWs && roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room && room.users) {
        for (const [, u] of room.users.entries()) {
          const ws = workspaces.get(u.workspaceId);
          if (ws && ws.files && ws.files.size > 0) {
            targetWs = ws;
            break;
          }
        }
      }
    }
  }

  // 3. If targetWs is still missing, recreate or adopt
  if (!targetWs) {
    const wsId = workspaceId || `workspace:${uuidv4()}`;
    targetWs = createPersonalWorkspace(wsId);
    workspaces.set(targetWs.id, targetWs);
  }

  // 4. Sync client's live code & activeFile to targetWs
  if (clientCode !== undefined && clientActiveFile) {
    if (targetWs.files.has(clientActiveFile)) {
      targetWs.files.get(clientActiveFile).code = clientCode;
    } else {
      targetWs.files.set(clientActiveFile, {
        code: clientCode,
        language: guessLanguageFromPath(clientActiveFile),
      });
    }
    targetWs.activeFile = clientActiveFile;
    targetWs.code = clientCode;
  } else if (targetWs.activeFile && targetWs.files.has(targetWs.activeFile)) {
    targetWs.files.get(targetWs.activeFile).code = targetWs.code;
  }

  // 5. If targetWs still has 0 files, check if targetWs.code has content to save as default file
  if (!targetWs.files || targetWs.files.size === 0) {
    if (targetWs.code && targetWs.code.trim()) {
      const defaultName = targetWs.activeFile || "index.html";
      targetWs.files.set(defaultName, {
        code: targetWs.code,
        language: targetWs.language || guessLanguageFromPath(defaultName),
      });
      targetWs.activeFile = defaultName;
    } else {
      return res.status(400).json({ error: "No files found in workspace to commit. Open or edit a file before pushing." });
    }
  }

  const cleanToken = token.trim();
  const headers = {
    "User-Agent": "PairEditor-App",
    "Accept": "application/vnd.github.v3+json",
    "Authorization": `Bearer ${cleanToken}`,
    "Content-Type": "application/json",
  };

  try {
    // 1. Get branch reference
    let latestCommitSha = null;
    let refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { headers });

    if (refRes.status === 404 && createBranch) {
      // Find default branch to branch off of
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) {
        return res.status(repoRes.status).json({ error: `Repository '${owner}/${repo}' not found or access denied.` });
      }
      const repoData = await repoRes.json();
      const defaultBranch = repoData.default_branch || "main";

      const defRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { headers });
      if (!defRefRes.ok) {
        return res.status(defRefRes.status).json({ error: `Could not read default branch '${defaultBranch}'.` });
      }
      const defRefData = await defRefRes.json();
      const baseSha = defRefData.object.sha;

      // Create the new branch
      const createRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        }),
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

    // 2. Get base commit to get tree SHA
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`, { headers });
    if (!commitRes.ok) {
      return res.status(commitRes.status).json({ error: "Failed to fetch base commit." });
    }
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs for all workspace files
    const treeEntries = [];
    for (const [filePath, fileObj] of targetWs.files.entries()) {
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

    // 4. Create new Git tree
    const newTreeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeEntries,
      }),
    });
    if (!newTreeRes.ok) {
      const err = await newTreeRes.json().catch(() => ({}));
      return res.status(newTreeRes.status).json({ error: `Failed to create Git tree: ${err.message || ""}` });
    }
    const newTreeData = await newTreeRes.json();
    const newTreeSha = newTreeData.sha;

    // 5. Create new commit
    const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: message || "Update from PairEditor collaborative session",
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

    // 6. Update branch reference
    const updateRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sha: newCommitSha,
        force: false,
      }),
    });
    if (!updateRefRes.ok) {
      const err = await updateRefRes.json().catch(() => ({}));
      return res.status(updateRefRes.status).json({
        error: `Failed to update branch reference '${branch}': ${err.message || ""}`,
      });
    }

    const commitUrl = `https://github.com/${owner}/${repo}/commit/${newCommitSha}`;

    targetWs.githubRepo = {
      owner,
      repo,
      branch,
      repoUrl: `https://github.com/${owner}/${repo}`,
      lastCommitSha: newCommitSha,
      lastCommitUrl: commitUrl,
      lastPushedAt: Date.now(),
    };

    // Since files are now pushed to GitHub, update originalCode to match current code
    for (const [, f] of targetWs.files.entries()) {
      f.originalCode = f.code;
    }
    const currentActive = targetWs.activeFile && targetWs.files.has(targetWs.activeFile)
      ? targetWs.files.get(targetWs.activeFile)
      : null;

    io.to(`ws:${targetWs.id}`).emit("github-repo-linked", targetWs.githubRepo);
    io.to(`ws:${targetWs.id}`).emit("files-update", {
      files: fileListFor(targetWs),
      activeFile: targetWs.activeFile,
    });
    if (currentActive) {
      io.to(`ws:${targetWs.id}`).emit("active-file-changed", {
        path: targetWs.activeFile,
        code: targetWs.code,
        language: targetWs.language,
        originalCode: currentActive.originalCode ?? null,
        lineAuthors: Object.fromEntries(targetWs.lineAuthors),
      });
    }

    // Announce in room chat
    if (roomId) {
      io.to(roomId).emit("chat-message", {
        id: uuidv4(),
        userId: "system",
        userName: "GitHub",
        color: "#6FE3A6",
        message: `🚀 ${authorName || "Someone"} pushed commit ${newCommitSha.slice(0, 7)} to ${branch}: "${message || "Update"}"`,
        timestamp: Date.now(),
      });
    }

    res.json({
      success: true,
      commitSha: newCommitSha,
      commitUrl,
      branch,
      filesCount: treeEntries.length,
      githubRepo: targetWs.githubRepo,
    });
  } catch (err) {
    console.error("[github/push] error:", err);
    res.status(500).json({ error: err.message || "Failed to commit and push to GitHub." });
  }
});

/**
 * Pull latest changes from GitHub for a repository into the workspace.
 * POST /api/github/pull
 * Body: { roomId, workspaceId, owner, repo, branch, token }
 */
app.post("/api/github/pull", async (req, res) => {
  const { roomId, workspaceId, owner: reqOwner, repo: reqRepo, branch: reqBranch, token } = req.body;

  let targetWs = null;
  if (workspaceId && workspaces.has(workspaceId)) {
    targetWs = workspaces.get(workspaceId);
  } else {
    for (const [, ws] of workspaces.entries()) {
      if (ws.githubRepo || (ws.files && ws.files.size > 0)) {
        targetWs = ws;
        break;
      }
    }
  }

  if (!targetWs) {
    const wsId = workspaceId || `workspace:${uuidv4()}`;
    targetWs = createPersonalWorkspace(wsId);
    workspaces.set(targetWs.id, targetWs);
  }

  const owner = reqOwner || targetWs.githubRepo?.owner;
  const repo = reqRepo || targetWs.githubRepo?.repo;
  let branch = reqBranch || targetWs.githubRepo?.branch || "main";

  if (!owner || !repo) {
    return res.status(400).json({ error: "Repository owner and repo name are required to pull." });
  }

  const headers = {
    "User-Agent": "PairEditor-App",
    "Accept": "application/vnd.github.v3+json",
  };
  if (token && token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  try {
    // 1. Fetch branch commit to know latest SHA
    const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { headers });
    let latestSha = null;
    if (branchRes.ok) {
      const bData = await branchRes.json();
      latestSha = bData.object?.sha;
    }

    // 2. Fetch recursive git tree
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
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

    // 3. Filter candidate files
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

    // 4. Download file blobs in batches
    const fetchedFiles = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < candidateFiles.length; i += BATCH_SIZE) {
      const batch = candidateFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          try {
            const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${item.sha}`, {
              headers: { ...headers, "Accept": "application/vnd.github.raw+json" },
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

    // 5. Update target workspace files
    targetWs.files = new Map();
    fetchedFiles.forEach(({ path, content, language }) => {
      targetWs.files.set(path, { code: content, language, originalCode: content });
    });

    // Retain existing activeFile if it exists in the fetched files, else pick preferred
    if (!targetWs.activeFile || !targetWs.files.has(targetWs.activeFile)) {
      const preferredFiles = ["index.html", "src/App.jsx", "src/App.js", "README.md", "src/index.js", "package.json"];
      const foundPref = preferredFiles.find((p) => targetWs.files.has(p));
      targetWs.activeFile = foundPref || fetchedFiles[0].path;
    }

    const activeObj = targetWs.files.get(targetWs.activeFile);
    targetWs.code = activeObj.code;
    targetWs.language = activeObj.language;
    targetWs.githubRepo = {
      owner,
      repo,
      branch,
      repoUrl: `https://github.com/${owner}/${repo}`,
      lastCommitSha: latestSha,
      lastPulledAt: Date.now(),
    };

    // 6. Broadcast updates to workspace members
    io.to(`ws:${targetWs.id}`).emit("files-update", {
      files: fileListFor(targetWs),
      activeFile: targetWs.activeFile,
    });
    io.to(`ws:${targetWs.id}`).emit("active-file-changed", {
      path: targetWs.activeFile,
      code: targetWs.code,
      language: targetWs.language,
      originalCode: activeObj.originalCode ?? null,
      lineAuthors: {},
    });
    io.to(`ws:${targetWs.id}`).emit("github-repo-linked", targetWs.githubRepo);

    if (roomId) {
      io.to(roomId).emit("chat-message", {
        id: uuidv4(),
        userId: "system",
        userName: "GitHub",
        color: "#6FE3A6",
        message: `📥 Pulled latest changes (${fetchedFiles.length} files) from ${owner}/${repo}@${branch}`,
        timestamp: Date.now(),
      });
    }

    res.json({
      success: true,
      count: fetchedFiles.length,
      owner,
      repo,
      branch,
      activeFile: targetWs.activeFile,
      commitSha: latestSha,
      githubRepo: targetWs.githubRepo,
    });
  } catch (err) {
    console.error("[github/pull] error:", err);
    res.status(500).json({ error: err.message || "Failed to pull from GitHub." });
  }
});

/**
 * Export current workspace or active file as a GitHub Gist.
 * POST /api/github/gist/export
 * Body: { workspaceId, description, isPublic, token, activeOnly }
 */
app.post("/api/github/gist/export", async (req, res) => {
  const { workspaceId, description, isPublic, token, activeOnly } = req.body;
  let targetWs = null;
  if (workspaceId && workspaces.has(workspaceId)) {
    targetWs = workspaces.get(workspaceId);
  } else {
    for (const [, ws] of workspaces.entries()) {
      targetWs = ws;
      break;
    }
  }

  if (!targetWs) {
    return res.status(404).json({ error: "Workspace not found." });
  }

  if (targetWs.activeFile && targetWs.files.has(targetWs.activeFile)) {
    targetWs.files.get(targetWs.activeFile).code = targetWs.code;
  }

  const gistFiles = {};
  if (activeOnly && targetWs.activeFile) {
    const filename = targetWs.activeFile.split("/").pop() || "code.txt";
    gistFiles[filename] = { content: targetWs.code || "// empty file\n" };
  } else if (targetWs.files.size > 0) {
    for (const [path, obj] of targetWs.files.entries()) {
      const safeName = path.replace(/\//g, "-");
      gistFiles[safeName] = { content: obj.code || "// empty file\n" };
    }
  } else {
    gistFiles["main.js"] = { content: targetWs.code || "// empty file\n" };
  }

  const headers = {
    "User-Agent": "PairEditor-App",
    "Accept": "application/vnd.github.v3+json",
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
        description: description || "Created via PairEditor",
        public: !!isPublic,
        files: gistFiles,
      }),
    });

    if (!gistRes.ok) {
      const err = await gistRes.json().catch(() => ({}));
      return res.status(gistRes.status).json({ error: err.message || "Failed to create GitHub Gist." });
    }

    const data = await gistRes.json();
    res.json({
      success: true,
      gistId: data.id,
      gistUrl: data.html_url,
    });
  } catch (err) {
    console.error("[github/gist/export] error:", err);
    res.status(500).json({ error: err.message || "Failed to export to GitHub Gist." });
  }
});

/**
 * Import files from a GitHub Gist into the workspace.
 * POST /api/github/gist/import
 * Body: { roomId, workspaceId, gistId, token }
 */
app.post("/api/github/gist/import", async (req, res) => {
  const { roomId, workspaceId, gistId, token } = req.body;
  if (!gistId || !gistId.trim()) {
    return res.status(400).json({ error: "Gist ID or URL is required." });
  }

  const cleanId = gistId.trim().replace(/^https?:\/\/gist\.github\.com\/[^\/]+\//i, "").replace(/\/$/, "");

  let targetWs = null;
  if (workspaceId && workspaces.has(workspaceId)) {
    targetWs = workspaces.get(workspaceId);
  } else {
    for (const [, ws] of workspaces.entries()) {
      targetWs = ws;
      break;
    }
  }
  if (!targetWs) {
    return res.status(404).json({ error: "Workspace not found." });
  }

  const headers = {
    "User-Agent": "PairEditor-App",
    "Accept": "application/vnd.github.v3+json",
  };
  if (token && token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }

  try {
    const gistRes = await fetch(`https://api.github.com/gists/${cleanId}`, { headers });
    if (!gistRes.ok) {
      if (gistRes.status === 404) return res.status(404).json({ error: `Gist '${cleanId}' not found.` });
      return res.status(gistRes.status).json({ error: "Failed to fetch GitHub Gist." });
    }
    const gistData = await gistRes.json();
    if (!gistData.files) {
      return res.status(400).json({ error: "Gist has no files." });
    }

    targetWs.files = new Map();
    const fileEntries = Object.entries(gistData.files);
    fileEntries.forEach(([filename, fileObj]) => {
      const content = fileObj.content || "";
      targetWs.files.set(filename, {
        code: content,
        language: guessLanguageFromPath(filename),
        originalCode: content,
      });
    });

    targetWs.activeFile = fileEntries[0][0];
    const activeObj = targetWs.files.get(targetWs.activeFile);
    targetWs.code = activeObj.code;
    targetWs.language = activeObj.language;
    targetWs.lineAuthors = new Map();

    io.to(`ws:${targetWs.id}`).emit("files-update", {
      files: fileListFor(targetWs),
      activeFile: targetWs.activeFile,
    });
    io.to(`ws:${targetWs.id}`).emit("active-file-changed", {
      path: targetWs.activeFile,
      code: targetWs.code,
      language: targetWs.language,
      originalCode: activeObj.originalCode ?? null,
      lineAuthors: {},
    });

    if (roomId) {
      io.to(roomId).emit("chat-message", {
        id: uuidv4(),
        userId: "system",
        userName: "GitHub",
        color: "#6FE3A6",
        message: `📋 Imported Gist (${fileEntries.length} files) from ${gistData.html_url}`,
        timestamp: Date.now(),
      });
    }

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

// ── Socket.IO events ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── join-room ──────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId = roomId;

    const room = getRoom(roomId);
    const usedColors = [...room.users.values()].map((u) => u.color);
    const color = pickColor(usedColors);

    // Create a personal workspace for this user
    const personalWs = createPersonalWorkspace(socket.id);
    workspaces.set(personalWs.id, personalWs);

    socket.workspaceId = personalWs.id;
    socket.join(`ws:${personalWs.id}`);

    const userInfo = {
      id: socket.id,
      name: userName || "Anonymous",
      color,
      cursor: null,
      workspaceId: personalWs.id,
      workspaceType: "personal",
      sessionId: null,
    };
    room.users.set(socket.id, userInfo);

    console.log(`[room:${roomId}] ${userInfo.name} joined (personal workspace: ${personalWs.id})`);

    // Send workspace state & team state to joining user
    const wsState = workspaceStatePayload(personalWs);
    socket.emit("workspace-state", wsState);
    socket.emit("room-state", {
      ...wsState,
      users: getTeamUsers(room),
    });

    // Notify others in room
    socket.to(roomId).emit("user-joined", userInfo);

    // Broadcast authoritative team presence list
    const teamUsers = getTeamUsers(room);
    io.to(roomId).emit("users-update", teamUsers);
    io.to(roomId).emit("presence-update", teamUsers);
  });

  // ── Collaboration request / response ───────────────────────────────────────
  socket.on("collab-request", ({ toUserId }) => {
    const roomId = socket.roomId;
    if (!roomId || !toUserId || toUserId === socket.id) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const senderUser = room.users.get(socket.id);
    const targetUser = room.users.get(toUserId);
    if (!senderUser || !targetUser) return;

    // Reject if both users are already in the same session
    if (
      senderUser.workspaceType === "session" &&
      senderUser.workspaceId === targetUser.workspaceId
    ) {
      return;
    }

    // Ignore duplicate requests from same sender while pending
    const reqKey = `${socket.id}->${toUserId}`;
    if (pendingCollabRequests.has(reqKey)) return;

    // Set 60-second expiration timer
    const timer = setTimeout(() => {
      if (pendingCollabRequests.has(reqKey)) {
        io.to(toUserId).emit("collab-request-cancelled", { fromUserId: socket.id });
        resolvePendingRequest(reqKey, "expired");
      }
    }, 60 * 1000);

    pendingCollabRequests.set(reqKey, {
      fromUserId: socket.id,
      toUserId,
      fromName: senderUser.name,
      fromColor: senderUser.color,
      timestamp: Date.now(),
      timer,
    });

    // Send request popup to target user
    io.to(toUserId).emit("collab-request-received", {
      fromUserId: socket.id,
      fromName: senderUser.name,
      fromColor: senderUser.color,
    });

    socket.emit("collab-request-sent", { toUserId });
  });

  socket.on("collab-request-cancel", ({ toUserId }) => {
    if (!toUserId) return;
    const reqKey = `${socket.id}->${toUserId}`;
    if (pendingCollabRequests.has(reqKey)) {
      io.to(toUserId).emit("collab-request-cancelled", { fromUserId: socket.id });
      resolvePendingRequest(reqKey, "cancelled");
    }
  });

  socket.on("collab-respond", ({ fromUserId, accept }) => {
    const roomId = socket.roomId;
    if (!roomId || !fromUserId) return;

    const reqKey = `${fromUserId}->${socket.id}`;
    if (!pendingCollabRequests.has(reqKey)) return;

    const room = rooms.get(roomId);
    if (!room) {
      resolvePendingRequest(reqKey, "cancelled");
      return;
    }

    const requesterUser = room.users.get(fromUserId);
    const targetUser = room.users.get(socket.id);
    if (!requesterUser || !targetUser) {
      resolvePendingRequest(reqKey, "cancelled");
      return;
    }

    if (!accept) {
      // Notify requester that collaboration was declined
      io.to(fromUserId).emit("collab-declined", {
        byUserId: socket.id,
        byName: targetUser.name,
      });
      resolvePendingRequest(reqKey, "declined");
      return;
    }

    // Accepted: resolve this request
    resolvePendingRequest(reqKey, "accepted");
    // Clear any other pending requests involving either user
    clearPendingRequestsForUser(fromUserId, "cancelled");
    clearPendingRequestsForUser(socket.id, "cancelled");

    const requesterSocket = io.sockets.sockets.get(fromUserId);
    if (!requesterSocket) return;

    let sessionWs = null;
    const reqWs = workspaces.get(requesterSocket.workspaceId);

    if (reqWs && reqWs.type === "session") {
      // Requester is already inside a shared session workspace
      sessionWs = reqWs;
    } else {
      // Requester is in a personal workspace -> create a new session
      const sessionId = uuidv4().slice(0, 8);
      const sessionWsId = `session:${sessionId}`;
      sessionWs = cloneWorkspaceForSession(reqWs, sessionWsId);
      workspaces.set(sessionWsId, sessionWs);

      // Move requester into the new session workspace
      if (reqWs) {
        requesterSocket.leave(`ws:${reqWs.id}`);
        reqWs.members.delete(fromUserId);
      }
      requesterSocket.join(`ws:${sessionWsId}`);
      requesterSocket.workspaceId = sessionWsId;
      sessionWs.members.add(fromUserId);

      requesterUser.workspaceId = sessionWsId;
      requesterUser.workspaceType = "session";
      requesterUser.sessionId = sessionId;

      requesterSocket.emit("workspace-state", workspaceStatePayload(sessionWs));
    }

    const sessionWsId = sessionWs.id;
    const sessionId = sessionWsId.replace("session:", "");

    // Move the accepting user (socket)
    const targetOldWs = workspaces.get(socket.workspaceId);
    if (targetOldWs && targetOldWs.id !== sessionWsId) {
      socket.leave(`ws:${targetOldWs.id}`);
      targetOldWs.members.delete(socket.id);
      if (targetOldWs.type === "session") {
        socket.to(`ws:${targetOldWs.id}`).emit("session-member-left", {
          userId: socket.id,
          userName: targetUser.name,
        });
        io.to(`ws:${targetOldWs.id}`).emit("session-update", {
          sessionId: targetOldWs.id.replace("session:", ""),
          members: getSessionMembers(targetOldWs, room),
        });
        if (targetOldWs.members.size === 0) {
          workspaces.delete(targetOldWs.id);
        }
      }
    }

    socket.join(`ws:${sessionWsId}`);
    socket.workspaceId = sessionWsId;
    sessionWs.members.add(socket.id);

    targetUser.workspaceId = sessionWsId;
    targetUser.workspaceType = "session";
    targetUser.sessionId = sessionId;

    // Send full session workspace state to accepter
    socket.emit("workspace-state", workspaceStatePayload(sessionWs));

    // Notify other session members
    socket.to(`ws:${sessionWsId}`).emit("session-member-joined", { member: targetUser });

    // Broadcast session member update to everyone in this session
    io.to(`ws:${sessionWsId}`).emit("session-update", {
      sessionId,
      members: getSessionMembers(sessionWs, room),
    });

    // Update presence for everyone in the team room
    const teamUsers = getTeamUsers(room);
    io.to(roomId).emit("presence-update", teamUsers);
    io.to(roomId).emit("users-update", teamUsers);
  });

  // ── Leave session ──────────────────────────────────────────────────────────
  socket.on("leave-session", () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user || user.workspaceType !== "session") return;

    const currentWs = workspaces.get(socket.workspaceId);
    if (!currentWs || currentWs.type !== "session") return;

    // Ensure active file in session has latest edits
    if (currentWs.activeFile && currentWs.files.has(currentWs.activeFile)) {
      currentWs.files.get(currentWs.activeFile).code = currentWs.code;
    }

    // 1. Initialise personal workspace with a snapshot COPY of current session state
    const personalWsId = `personal:${socket.id}`;
    const personalWs = cloneWorkspaceForPersonal(currentWs, personalWsId);
    workspaces.set(personalWsId, personalWs);

    // 2. Remove socket from the session (handles dissolution if only 1 member remains)
    removeSocketFromSession(socket, currentWs, room);

    // 3. Move socket into their personal workspace
    personalWs.members.add(socket.id);
    socket.workspaceId = personalWs.id;
    socket.join(`ws:${personalWs.id}`);

    user.workspaceId = personalWs.id;
    user.workspaceType = "personal";
    user.sessionId = null;

    // 4. Send fresh personal workspace state to leaver
    socket.emit("workspace-state", workspaceStatePayload(personalWs));
    socket.emit("session-update", { sessionId: null, members: [] });

    // 5. Update team room presence
    const teamUsers = getTeamUsers(room);
    io.to(roomId).emit("presence-update", teamUsers);
    io.to(roomId).emit("users-update", teamUsers);
  });

  // ── Scoped workspace editor events ─────────────────────────────────────────

  // Code change
  socket.on("code-change", ({ code }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    ws.code = code;
    if (ws.activeFile && ws.files.has(ws.activeFile)) {
      ws.files.get(ws.activeFile).code = code;
    }
    socket.to(`ws:${ws.id}`).emit("code-update", { code, senderId: socket.id });
  });

  // Language change
  socket.on("language-change", ({ language }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    ws.language = language;
    io.to(`ws:${ws.id}`).emit("language-update", { language });
  });

  // Cursor move
  socket.on("cursor-move", ({ cursor }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    const room = rooms.get(socket.roomId);
    const user = room?.users.get(socket.id);
    if (user) user.cursor = cursor;
    socket.to(`ws:${ws.id}`).emit("cursor-update", { userId: socket.id, cursor });
  });

  // Typing indicator
  socket.on("typing-start", () => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    socket.to(`ws:${ws.id}`).emit("user-typing", { userId: socket.id });
  });

  socket.on("typing-stop", () => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    socket.to(`ws:${ws.id}`).emit("user-stopped-typing", { userId: socket.id });
  });

  // Line author blame update
  socket.on("line-author-update", ({ lines }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws || !Array.isArray(lines)) return;

    lines.forEach((entry) => {
      ws.lineAuthors.set(entry.line, {
        name: entry.name,
        color: entry.color,
        userId: entry.userId,
      });
    });

    if (ws.activeFile) {
      if (!ws.lineAuthorsByFile.has(ws.activeFile)) {
        ws.lineAuthorsByFile.set(ws.activeFile, new Map());
      }
      const fileBlame = ws.lineAuthorsByFile.get(ws.activeFile);
      lines.forEach((entry) => {
        fileBlame.set(entry.line, {
          name: entry.name,
          color: entry.color,
          userId: entry.userId,
        });
      });
    }

    socket.to(`ws:${ws.id}`).emit("line-author-update", { lines });
  });

  // Create file
  socket.on("create-file", ({ path, code, language }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws || !path) return;

    const safePath = String(path).replace(/^\/+/, "");
    const existing = ws.files.get(safePath);
    if (existing) {
      ws.activeFile = safePath;
      ws.code = existing.code;
      ws.language = existing.language;
      io.to(`ws:${ws.id}`).emit("files-update", { files: fileListFor(ws), activeFile: ws.activeFile });
      io.to(`ws:${ws.id}`).emit("active-file-changed", {
        path: ws.activeFile,
        code: ws.code,
        language: ws.language,
        originalCode: existing.originalCode ?? null,
        lineAuthors: Object.fromEntries(ws.lineAuthors),
      });
      return;
    }

    const fileLanguage = language || guessLanguageFromPath(safePath);
    ws.files.set(safePath, { code: code || "", language: fileLanguage });
    ws.activeFile = safePath;
    ws.code = ws.files.get(safePath).code;
    ws.language = ws.files.get(safePath).language;
    ws.lineAuthors = new Map();

    io.to(`ws:${ws.id}`).emit("files-update", { files: fileListFor(ws), activeFile: ws.activeFile });
    io.to(`ws:${ws.id}`).emit("active-file-changed", {
      path: ws.activeFile,
      code: ws.code,
      language: ws.language,
      originalCode: null,
      lineAuthors: {},
    });
  });

  // Rename file
  socket.on("rename-file", ({ oldPath, newPath }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws || !oldPath || !newPath) return;

    const oldNormalized = String(oldPath).replace(/^\/+/, "");
    const newNormalized = String(newPath).replace(/^\/+/, "");

    if (oldNormalized === newNormalized) return;
    if (ws.files.has(newNormalized)) {
      socket.emit("rename-file-error", { message: `A file named "${newNormalized}" already exists.` });
      return;
    }

    const fileEntry = ws.files.get(oldNormalized);
    if (!fileEntry) return;

    const wasActive = ws.activeFile === oldNormalized;
    ws.files.delete(oldNormalized);
    ws.files.set(newNormalized, { ...fileEntry });

    const existingBlame = ws.lineAuthorsByFile.get(oldNormalized);
    if (existingBlame) {
      ws.lineAuthorsByFile.set(newNormalized, new Map(existingBlame));
      ws.lineAuthorsByFile.delete(oldNormalized);
    }

    if (wasActive) {
      ws.activeFile = newNormalized;
      ws.code = ws.files.get(newNormalized).code;
      ws.language = ws.files.get(newNormalized).language;
      ws.lineAuthors = ws.lineAuthorsByFile.get(newNormalized) || new Map();
      io.to(`ws:${ws.id}`).emit("active-file-changed", {
        path: ws.activeFile,
        code: ws.code,
        language: ws.language,
        originalCode: fileEntry.originalCode ?? null,
        lineAuthors: Object.fromEntries(ws.lineAuthors),
      });
    }

    io.to(`ws:${ws.id}`).emit("files-update", { files: fileListFor(ws), activeFile: ws.activeFile });
  });

  // Delete file
  socket.on("delete-file", ({ path }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws || !path) return;

    const target = String(path).replace(/^\/+/, "");
    if (!ws.files.has(target)) return;

    const wasActive = ws.activeFile === target;
    ws.files.delete(target);
    ws.lineAuthorsByFile.delete(target);

    if (wasActive) {
      if (ws.files.size > 0) {
        const nextPath = [...ws.files.keys()][0];
        ws.activeFile = nextPath;
        ws.code = ws.files.get(nextPath).code;
        ws.language = ws.files.get(nextPath).language;
        ws.lineAuthors = ws.lineAuthorsByFile.get(nextPath) || new Map();
        io.to(`ws:${ws.id}`).emit("active-file-changed", {
          path: ws.activeFile,
          code: ws.code,
          language: ws.language,
          lineAuthors: Object.fromEntries(ws.lineAuthors),
        });
      } else {
        ws.activeFile = null;
        ws.code = "// Start coding here...\n";
        ws.language = "javascript";
        ws.lineAuthors = new Map();
        io.to(`ws:${ws.id}`).emit("active-file-changed", {
          path: null,
          code: ws.code,
          language: ws.language,
          lineAuthors: {},
        });
      }
    }

    io.to(`ws:${ws.id}`).emit("files-update", { files: fileListFor(ws), activeFile: ws.activeFile });
  });

  // Upload folder
  socket.on("upload-folder", ({ files }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws || !Array.isArray(files) || !files.length) return;

    files.forEach(({ path, content, language }) => {
      ws.files.set(path, { code: content, language: language || "plaintext" });
    });

    let activeChanged = false;
    if (!ws.activeFile) {
      ws.activeFile = files[0].path;
      const active = ws.files.get(ws.activeFile);
      ws.code = active.code;
      ws.language = active.language;
      ws.lineAuthors = new Map();
      activeChanged = true;
    }

    const payload = { files: fileListFor(ws), activeFile: ws.activeFile };
    io.to(`ws:${ws.id}`).emit("files-update", payload);

    if (activeChanged) {
      io.to(`ws:${ws.id}`).emit("active-file-changed", {
        path: ws.activeFile,
        code: ws.code,
        language: ws.language,
        lineAuthors: {},
      });
    }
  });

  // Switch active file
  socket.on("switch-file", ({ path }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws || !ws.files.has(path)) return;

    if (ws.activeFile && ws.files.has(ws.activeFile)) {
      ws.files.get(ws.activeFile).code = ws.code;
      ws.lineAuthorsByFile.set(
        ws.activeFile,
        new Map(
          Object.entries(Object.fromEntries(ws.lineAuthors)).map(([line, v]) => [
            Number(line),
            v,
          ])
        )
      );
    }

    ws.activeFile = path;
    const active = ws.files.get(path);
    ws.code = active.code;
    ws.language = active.language;
    ws.lineAuthors = ws.lineAuthorsByFile.get(path) || new Map();

    io.to(`ws:${ws.id}`).emit("active-file-changed", {
      path,
      code: ws.code,
      language: ws.language,
      originalCode: active.originalCode ?? null,
      lineAuthors: Object.fromEntries(ws.lineAuthors),
    });
  });

  // ── Team Chat (stays room-wide for all members in the room) ────────────────
  socket.on("chat-message", ({ message }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    const payload = {
      id: uuidv4(),
      userId: socket.id,
      userName: user?.name || "Anonymous",
      color: user?.color || "#fff",
      message,
      timestamp: Date.now(),
    };
    io.to(roomId).emit("chat-message", payload);
  });

  // ── Scoped Whiteboard events ───────────────────────────────────────────────
  socket.on("whiteboard-update", ({ elements }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    ws.whiteboard = Array.isArray(elements) ? elements : [];
    socket.to(`ws:${ws.id}`).emit("whiteboard-update", { elements: ws.whiteboard });
  });

  socket.on("whiteboard-draw-step", ({ stroke }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    socket.to(`ws:${ws.id}`).emit("whiteboard-draw-step", { stroke, userId: socket.id });
  });

  socket.on("whiteboard-cursor", ({ cursor }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    const room = rooms.get(socket.roomId);
    const user = room?.users.get(socket.id);
    socket.to(`ws:${ws.id}`).emit("whiteboard-cursor-update", {
      userId: socket.id,
      userName: user?.name || "Peer",
      color: user?.color || "#6FE3A6",
      cursor,
    });
  });

  socket.on("whiteboard-clear", () => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    ws.whiteboard = [];
    io.to(`ws:${ws.id}`).emit("whiteboard-update", { elements: [] });
  });

  // ── Scoped View Mode Change (syncs only inside current workspace) ───────────
  socket.on("view-mode-change", ({ viewMode }) => {
    const ws = getSocketWorkspace(socket);
    if (!ws) return;
    ws.viewMode = viewMode;
    const room = rooms.get(socket.roomId);
    const user = room?.users.get(socket.id);
    io.to(`ws:${ws.id}`).emit("view-mode-update", {
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
    room.users.delete(socket.id);

    console.log(`[-] Socket disconnected: ${socket.id} from room ${roomId}`);

    // If socket was inside a session workspace, remove them and notify peers
    if (socket.workspaceId) {
      const currentWs = workspaces.get(socket.workspaceId);
      if (currentWs && currentWs.type === "session") {
        removeSocketFromSession(socket, currentWs, room);
      }
    }

    // Clean up personal workspace
    workspaces.delete(`personal:${socket.id}`);

    // Clean up all pending requests involving this socket
    clearPendingRequestsForUser(socket.id, "cancelled");

    // Notify room of departure
    socket.to(roomId).emit("user-left", { userId: socket.id });
    const teamUsers = getTeamUsers(room);
    io.to(roomId).emit("users-update", teamUsers);
    io.to(roomId).emit("presence-update", teamUsers);

    // Clean up empty rooms after 30 mins
    if (room.users.size === 0) {
      setTimeout(() => {
        if (rooms.get(roomId)?.users.size === 0) {
          rooms.delete(roomId);
          console.log(`[room:${roomId}] cleaned up (empty)`);
        }
      }, 30 * 60 * 1000);
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 PairEditor server running on http://localhost:${PORT}\n`);
});
