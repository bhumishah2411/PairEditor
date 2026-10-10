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
 * pendingCollabRequests: Map<`${fromUserId}->${toUserId}`, { fromUserId, toUserId, timestamp }>
 */
const pendingCollabRequests = new Map();

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
  };
}

/** Deep clone a workspace state to initialise a shared session */
function cloneWorkspaceForSession(sourceWs, sessionWsId) {
  const newFiles = new Map();
  if (sourceWs?.files) {
    sourceWs.files.forEach((fileObj, path) => {
      newFiles.set(path, { code: fileObj.code, language: fileObj.language });
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
  };
}

/** Serialise a workspace's file list (path + language only — keeps it lightweight) */
function fileListFor(ws) {
  if (!ws || !ws.files) return [];
  return [...ws.files.keys()].map((path) => ({
    path,
    language: ws.files.get(path).language,
  }));
}

/** Format full workspace payload to send to clients */
function workspaceStatePayload(ws) {
  return {
    workspaceId: ws.id,
    workspaceType: ws.type,
    code: ws.code,
    language: ws.language,
    lineAuthors: Object.fromEntries(ws.lineAuthors),
    files: fileListFor(ws),
    activeFile: ws.activeFile,
    whiteboard: ws.whiteboard || [],
    viewMode: ws.viewMode || "code",
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
      newFiles.set(path, { code: String(fileObj.code ?? ""), language: fileObj.language || "plaintext" });
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

    pendingCollabRequests.set(reqKey, {
      fromUserId: socket.id,
      toUserId,
      fromName: senderUser.name,
      fromColor: senderUser.color,
      timestamp: Date.now(),
    });

    // Send request popup to target user
    io.to(toUserId).emit("collab-request-received", {
      fromUserId: socket.id,
      fromName: senderUser.name,
      fromColor: senderUser.color,
    });

    socket.emit("collab-request-sent", { toUserId });
  });

  socket.on("collab-respond", ({ fromUserId, accept }) => {
    const roomId = socket.roomId;
    if (!roomId || !fromUserId) return;

    const reqKey = `${fromUserId}->${socket.id}`;
    if (!pendingCollabRequests.has(reqKey)) return;
    pendingCollabRequests.delete(reqKey);

    const room = rooms.get(roomId);
    if (!room) return;

    const requesterUser = room.users.get(fromUserId);
    const targetUser = room.users.get(socket.id);
    if (!requesterUser || !targetUser) return;

    if (!accept) {
      // Notify requester that collaboration was declined
      io.to(fromUserId).emit("collab-declined", {
        byUserId: socket.id,
        byName: targetUser.name,
      });
      return;
    }

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

    // Clean up pending requests involving this socket
    for (const [key, req] of pendingCollabRequests.entries()) {
      if (req.fromUserId === socket.id) {
        pendingCollabRequests.delete(key);
        io.to(req.toUserId).emit("collab-request-cancelled", { fromUserId: socket.id });
      } else if (req.toUserId === socket.id) {
        pendingCollabRequests.delete(key);
        io.to(req.fromUserId).emit("collab-declined", {
          byUserId: socket.id,
          byName: user?.name || "Peer",
          reason: "User disconnected",
        });
      }
    }

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
