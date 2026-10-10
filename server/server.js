/**
 * PairEditor – Real-time Collaborative Code Editor
 * Backend: Express + Socket.IO
 *
 * Architecture overview:
 *  - Rooms are created on-demand when the first user joins.
 *  - Each room stores the current code content in memory.
 *  - Socket.IO broadcasts events to all clients in the same room.
 *  - No CRDT/OT; last-write wins is fine at this scale.
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

// ── In-memory store ──────────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, { code, language, users: Map<socketId, userInfo> }>
 * userInfo: { id, name, color, cursor }
 */
const rooms = new Map();

/** Predefined user colours so each visitor gets a unique accent */
const USER_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57",
  "#FF9FF3", "#54A0FF", "#5F27CD", "#00D2D3", "#FF9F43",
  "#48DBFB", "#1DD1A1", "#F368E0", "#EE5A24", "#009432",
];

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      code: "// Start coding here...\n",
      language: "javascript",
      users: new Map(),
      // lineAuthors: Map<lineNumber, { name, color, userId }>
      // Persists "who last edited this line" across the whole session.
      lineAuthors: new Map(),
      // ── Multi-file support ──────────────────────────────────────────────
      // files: Map<relativePath, { code, language }> — everything uploaded so far.
      // activeFile: the path currently loaded into the shared `code` buffer above.
      // Everyone in the room views/edits the SAME active file at once, matching
      // the existing single-buffer model — switching files switches it for all.
      files: new Map(),
      activeFile: null,
      // lineAuthorsByFile: Map<path, Map<line, authorInfo>> — blame per file,
      // restored into `lineAuthors` whenever that file becomes active.
      lineAuthorsByFile: new Map(),
      // ── Whiteboard collaborative canvas elements ────────────────────────
      whiteboard: [],
      // ── Room view mode ('code' | 'split' | 'whiteboard') ─────────────────
      viewMode: "code",
    });
  }
  return rooms.get(roomId);
}

/** Serialise a room's file list (path + language only — no content, keeps it light) */
function fileListFor(room) {
  return [...room.files.keys()].map((path) => ({
    path,
    language: room.files.get(path).language,
  }));
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
  // Fallback: random hex
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
 * Download everything uploaded to a room as a .zip.
 * Streams directly from the in-memory files map — no temp files on disk.
 */
app.get("/api/room/:roomId/download", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room || room.files.size === 0) {
    return res.status(404).json({ error: "No files uploaded in this room yet." });
  }

  // Make sure the currently active file reflects the latest live edits
  if (room.activeFile && room.files.has(room.activeFile)) {
    room.files.get(room.activeFile).code = room.code;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="pairEditor-${req.params.roomId}.zip"`
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

    const userInfo = { id: socket.id, name: userName || "Anonymous", color, cursor: null };
    room.users.set(socket.id, userInfo);

    console.log(`[room:${roomId}] ${userInfo.name} joined (${socket.id})`);

    // Send the current code + blame map to the joining user
    socket.emit("room-state", {
      code: room.code,
      language: room.language,
      users: [...room.users.values()],
      // Convert Map → plain object so it survives JSON serialisation
      lineAuthors: Object.fromEntries(room.lineAuthors),
      files: fileListFor(room),
      activeFile: room.activeFile,
      whiteboard: room.whiteboard || [],
      viewMode: room.viewMode || "code",
    });

    // Notify everyone else that a new user joined
    socket.to(roomId).emit("user-joined", userInfo);

    // Broadcast updated user list to everyone in the room
    io.to(roomId).emit("users-update", [...room.users.values()]);
  });

  // ── code-change ────────────────────────────────────────────────────────────
  socket.on("code-change", ({ roomId, code }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.code = code; // persist in memory
    // Also persist into the active file's own record, so switching away and back keeps it
    if (room.activeFile && room.files.has(room.activeFile)) {
      room.files.get(room.activeFile).code = code;
    }
    // Relay to all OTHER clients in the room
    socket.to(roomId).emit("code-update", { code, senderId: socket.id });
  });

  // ── language-change ────────────────────────────────────────────────────────
  socket.on("language-change", ({ roomId, language }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.language = language;
    io.to(roomId).emit("language-update", { language });
  });

  // ── cursor-move ────────────────────────────────────────────────────────────
  socket.on("cursor-move", ({ roomId, cursor }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.cursor = cursor;
    socket.to(roomId).emit("cursor-update", { userId: socket.id, cursor });
  });

  // ── typing indicator ───────────────────────────────────────────────────────
  socket.on("typing-start", ({ roomId }) => {
    socket.to(roomId).emit("user-typing", { userId: socket.id });
  });

  socket.on("typing-stop", ({ roomId }) => {
    socket.to(roomId).emit("user-stopped-typing", { userId: socket.id });
  });

  // ── line-author-update ────────────────────────────────────────────────────
  // Payload: { roomId, lines: [{ line, name, color, userId }] }
  // "lines" is the set of line numbers touched in the most recent edit.
  socket.on("line-author-update", ({ roomId, lines }) => {
    const room = rooms.get(roomId);
    if (!room || !Array.isArray(lines)) return;

    // Persist each changed line's author in the room state
    lines.forEach((entry) => {
      room.lineAuthors.set(entry.line, {
        name: entry.name,
        color: entry.color,
        userId: entry.userId,
      });
    });

    // Mirror into the active file's own blame map so it survives file switches
    if (room.activeFile) {
      if (!room.lineAuthorsByFile.has(room.activeFile)) {
        room.lineAuthorsByFile.set(room.activeFile, new Map());
      }
      const fileBlame = room.lineAuthorsByFile.get(room.activeFile);
      lines.forEach((entry) => {
        fileBlame.set(entry.line, {
          name: entry.name,
          color: entry.color,
          userId: entry.userId,
        });
      });
    }

    // Relay to all OTHER clients so they update their decorations
    socket.to(roomId).emit("line-author-update", { lines });
  });

  // ── create-file ─────────────────────────────────────────────────────────────
  // Payload: { roomId, path, code, language }
  socket.on("create-file", ({ roomId, path, code, language }) => {
    const room = rooms.get(roomId);
    if (!room || !path) return;

    const safePath = String(path).replace(/^\/+/, "");
    const existing = room.files.get(safePath);
    if (existing) {
      room.activeFile = safePath;
      room.code = existing.code;
      room.language = existing.language;
      io.to(roomId).emit("files-update", { files: fileListFor(room), activeFile: room.activeFile });
      io.to(roomId).emit("active-file-changed", {
        path: room.activeFile,
        code: room.code,
        language: room.language,
        lineAuthors: Object.fromEntries(room.lineAuthors),
      });
      return;
    }

    const fileLanguage = language || guessLanguageFromPath(safePath);
    room.files.set(safePath, { code: code || "", language: fileLanguage });
    room.activeFile = safePath;
    room.code = room.files.get(safePath).code;
    room.language = room.files.get(safePath).language;
    room.lineAuthors = new Map();

    io.to(roomId).emit("files-update", { files: fileListFor(room), activeFile: room.activeFile });
    io.to(roomId).emit("active-file-changed", {
      path: room.activeFile,
      code: room.code,
      language: room.language,
      lineAuthors: {},
    });
  });

  // ── rename-file ───────────────────────────────────────────────────────────
  // Payload: { roomId, oldPath, newPath }
  socket.on("rename-file", ({ roomId, oldPath, newPath }) => {
    const room = rooms.get(roomId);
    if (!room || !oldPath || !newPath) return;

    const oldNormalized = String(oldPath).replace(/^\/+/, "");
    const newNormalized = String(newPath).replace(/^\/+/, "");

    if (oldNormalized === newNormalized) return;
    if (room.files.has(newNormalized)) {
      socket.emit("rename-file-error", { message: `A file named "${newNormalized}" already exists in this room.` });
      return;
    }

    const fileEntry = room.files.get(oldNormalized);
    if (!fileEntry) return;

    const wasActive = room.activeFile === oldNormalized;
    room.files.delete(oldNormalized);
    room.files.set(newNormalized, { ...fileEntry });

    const existingBlame = room.lineAuthorsByFile.get(oldNormalized);
    if (existingBlame) {
      room.lineAuthorsByFile.set(newNormalized, new Map(existingBlame));
      room.lineAuthorsByFile.delete(oldNormalized);
    }

    if (wasActive) {
      room.activeFile = newNormalized;
      room.code = room.files.get(newNormalized).code;
      room.language = room.files.get(newNormalized).language;
      room.lineAuthors = room.lineAuthorsByFile.get(newNormalized) || new Map();
      io.to(roomId).emit("active-file-changed", {
        path: room.activeFile,
        code: room.code,
        language: room.language,
        lineAuthors: Object.fromEntries(room.lineAuthors),
      });
    }

    io.to(roomId).emit("files-update", { files: fileListFor(room), activeFile: room.activeFile });
  });

  // ── delete-file ───────────────────────────────────────────────────────────
  // Payload: { roomId, path }
  socket.on("delete-file", ({ roomId, path }) => {
    const room = rooms.get(roomId);
    if (!room || !path) return;

    const target = String(path).replace(/^\/+/, "");
    if (!room.files.has(target)) return;

    const wasActive = room.activeFile === target;
    room.files.delete(target);
    room.lineAuthorsByFile.delete(target);

    if (wasActive) {
      if (room.files.size > 0) {
        const nextPath = [...room.files.keys()][0];
        room.activeFile = nextPath;
        room.code = room.files.get(nextPath).code;
        room.language = room.files.get(nextPath).language;
        room.lineAuthors = room.lineAuthorsByFile.get(nextPath) || new Map();
        io.to(roomId).emit("active-file-changed", {
          path: room.activeFile,
          code: room.code,
          language: room.language,
          lineAuthors: Object.fromEntries(room.lineAuthors),
        });
      } else {
        room.activeFile = null;
        room.code = "// Start coding here...\n";
        room.language = "javascript";
        room.lineAuthors = new Map();
        io.to(roomId).emit("active-file-changed", {
          path: null,
          code: room.code,
          language: room.language,
          lineAuthors: {},
        });
      }
    }

    io.to(roomId).emit("files-update", { files: fileListFor(room), activeFile: room.activeFile });
  });

  // ── upload-folder ───────────────────────────────────────────────────────────
  // Payload: { roomId, files: [{ path, content, language }] }
  // Merges a batch of uploaded files into the room. If nothing is active yet,
  // the first uploaded file becomes the shared active buffer for everyone.
  socket.on("upload-folder", ({ roomId, files }) => {
    const room = rooms.get(roomId);
    if (!room || !Array.isArray(files) || !files.length) return;

    files.forEach(({ path, content, language }) => {
      room.files.set(path, { code: content, language: language || "plaintext" });
    });

    let activeChanged = false;
    if (!room.activeFile) {
      room.activeFile = files[0].path;
      const active = room.files.get(room.activeFile);
      room.code = active.code;
      room.language = active.language;
      room.lineAuthors = new Map(); // fresh file, no blame yet
      activeChanged = true;
    }

    const payload = { files: fileListFor(room), activeFile: room.activeFile };
    io.to(roomId).emit("files-update", payload);

    if (activeChanged) {
      io.to(roomId).emit("active-file-changed", {
        path: room.activeFile,
        code: room.code,
        language: room.language,
        lineAuthors: {},
      });
    }
  });

  // ── switch-file ──────────────────────────────────────────────────────────────
  // Everyone in the room shares one buffer, so switching the active file
  // switches it for the whole room — matches the pair-programming model.
  socket.on("switch-file", ({ roomId, path }) => {
    const room = rooms.get(roomId);
    if (!room || !room.files.has(path)) return;

    // Persist the outgoing file's latest code + blame before switching away
    if (room.activeFile && room.files.has(room.activeFile)) {
      room.files.get(room.activeFile).code = room.code;
      room.lineAuthorsByFile.set(room.activeFile, new Map(
        Object.entries(Object.fromEntries(room.lineAuthors)).map(
          ([line, v]) => [Number(line), v]
        )
      ));
    }

    room.activeFile = path;
    const active = room.files.get(path);
    room.code = active.code;
    room.language = active.language;
    room.lineAuthors = room.lineAuthorsByFile.get(path) || new Map();

    io.to(roomId).emit("active-file-changed", {
      path,
      code: room.code,
      language: room.language,
      lineAuthors: Object.fromEntries(room.lineAuthors),
    });
  });

  // ── chat message ───────────────────────────────────────────────────────────
  socket.on("chat-message", ({ roomId, message }) => {
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

  // ── whiteboard events ──────────────────────────────────────────────────────
  socket.on("whiteboard-update", ({ roomId, elements }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.whiteboard = Array.isArray(elements) ? elements : [];
    socket.to(roomId).emit("whiteboard-update", { elements: room.whiteboard });
  });

  socket.on("whiteboard-draw-step", ({ roomId, stroke }) => {
    socket.to(roomId).emit("whiteboard-draw-step", { stroke, userId: socket.id });
  });

  socket.on("whiteboard-cursor", ({ roomId, cursor }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    socket.to(roomId).emit("whiteboard-cursor-update", {
      userId: socket.id,
      userName: user?.name || "Peer",
      color: user?.color || "#6FE3A6",
      cursor,
    });
  });

  socket.on("whiteboard-clear", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.whiteboard = [];
    io.to(roomId).emit("whiteboard-update", { elements: [] });
  });

  // ── view-mode-change ──────────────────────────────────────────────────────
  socket.on("view-mode-change", ({ roomId, viewMode }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.viewMode = viewMode;
    const user = room.users.get(socket.id);
    io.to(roomId).emit("view-mode-update", {
      viewMode,
      senderName: user?.name || "Peer",
      senderId: socket.id,
    });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);

    console.log(`[-] Socket disconnected: ${socket.id} from room ${roomId}`);

    // Notify remaining users
    socket.to(roomId).emit("user-left", { userId: socket.id });
    io.to(roomId).emit("users-update", [...room.users.values()]);

    // Clean up empty rooms after 30 mins (avoid memory leaks)
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
