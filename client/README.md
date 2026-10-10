# PairEditor Client

Real-time collaborative code editor and whiteboard client built with React, Vite, Monaco Editor, and Tailwind CSS.

## Private Workspaces and Collaboration Sessions

PairEditor enables optional, on-demand collaboration within team rooms:

- **Team Room Presence & Chat**: Joining a room connects you to the team member list and team-wide chat.
- **Private Workspaces by Default**: Every member starts in their own private workspace (`personal:<socketId>`). Your code, file explorer, whiteboard, and view mode remain private until you choose to collaborate.
- **Collaboration Invitations**: Any member can send a collaboration request to another online peer. The recipient receives an animated Accept/Decline prompt.
- **Shared Session Workspaces**: Once accepted, users transition into a unified session workspace (`session:<sessionId>`), syncing the editor buffer, file tree, line authorship blame, and whiteboard in real time.
- **Multi-Member Sessions**: Additional members can be invited to an active session with no member count limit. Solo users continue working undisturbed.
- **Seamless Leave & Return**: Leaving a session returns you to your private workspace with your private code and files intact. Empty sessions are automatically cleaned up.

---

### Scripts

- `npm run dev`: Start Vite development server
- `npm run build`: Build for production
- `npm run preview`: Preview production build
