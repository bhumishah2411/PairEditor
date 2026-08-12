/**
 * useSocket – manages the Socket.IO connection lifecycle.
 *
 * Returns the connected socket instance and a boolean indicating
 * whether the connection is currently live.
 */
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Create the socket; autoConnect is true by default.
    const socket = io(SERVER_URL, {
      transports: ["websocket", "polling"], // prefer WS, fall back to long-poll
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[socket] connected:", socket.id);
      setConnected(true);
    });

    socket.on("disconnect", (reason) => {
      console.log("[socket] disconnected:", reason);
      setConnected(false);
    });

    socket.on("connect_error", (err) => {
      console.error("[socket] connection error:", err.message);
      setConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return { socket: socketRef.current, connected };
}
