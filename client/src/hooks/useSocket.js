/**
 * useSocket – manages the Socket.IO connection lifecycle.
 *
 * Returns the connected socket instance and a boolean indicating
 * whether the connection is currently live.
 */
import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export function useSocket() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Create the socket; autoConnect is true by default.
    const socketInstance = io(SERVER_URL, {
      transports: ["websocket", "polling"], // prefer WS, fall back to long-poll
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    setSocket(socketInstance);

    socketInstance.on("connect", () => {
      console.log("[socket] connected:", socketInstance.id);
      setConnected(true);
    });

    socketInstance.on("disconnect", (reason) => {
      console.log("[socket] disconnected:", reason);
      setConnected(false);
    });

    socketInstance.on("connect_error", (err) => {
      console.error("[socket] connection error:", err.message);
      setConnected(false);
    });

    return () => {
      socketInstance.disconnect();
    };
  }, []);

  return { socket, connected };
}
