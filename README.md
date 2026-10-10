# PairEditor

PairEditor is a real-time collaborative development environment featuring a Monaco code editor, multi-file explorer, interactive collaborative whiteboard, and team chat.

## Private Workspaces and Collaboration Sessions

Collaboration in PairEditor is flexible and optional:

1. **Team Room Presence**: A room ID groups a team for presence tracking and team-wide chat.
2. **Private Workspaces by Default**: Every participant starts in their own private workspace (`personal:<socketId>`). All code edits, file creation/upload, whiteboard diagrams, and view modes stay strictly private.
3. **Collaboration Requests**: Click **Collab** or **Invite** next to any member in the `$ team members` sidebar to invite them to a shared session.
4. **Shared Session Workspaces**: When an invitation is accepted, members join a shared session (`session:<sessionId>`). Changes to code, cursor positions, line authorship blame, and whiteboard strokes sync instantly across all session participants.
5. **Multi-Member Sessions**: Any member in a session can invite other solo members. Sessions support an unlimited number of participants while other teammates work solo concurrently.
6. **Leaving a Session**: Click **Leave** in the toolbar at any time to return to your private workspace with all your previous private work intact.

## Getting Started

### 1. Install dependencies
```bash
npm run install:all
```

### 2. Start the server and client
```bash
npm run dev
```
- Server: [http://localhost:3001](http://localhost:3001)
- Client: [http://localhost:5173](http://localhost:5173)
