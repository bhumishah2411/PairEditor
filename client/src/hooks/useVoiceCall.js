/**
 * useVoiceCall – Production-ready multi-user WebRTC Voice Calling hook.
 * Uses native RTCPeerConnection mesh with public STUN servers.
 * Relays signaling over the existing Socket.IO connection.
 * Includes:
 *   - Automatic ICE candidate queueing (zero dropped connections)
 *   - Audio track mute/unmute
 *   - Deafen support (mutes all incoming sound)
 *   - Local voice activity / volume analyzer for real-time speaking indicators
 *   - Clean disconnect & stream teardown
 */
import { useState, useEffect, useRef, useCallback } from "react";
import toast from "react-hot-toast";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

export default function useVoiceCall({ socket, roomId, currentUser }) {
  const [isInCall, setIsInCall] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [participants, setParticipants] = useState([]);

  // Refs for WebRTC resources
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map()); // socketId -> RTCPeerConnection
  const audioElementsRef = useRef(new Map()); // socketId -> HTMLAudioElement
  const pendingCandidatesRef = useRef(new Map()); // socketId -> RTCIceCandidate[]
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const speakingIntervalRef = useRef(null);
  const isSpeakingRef = useRef(false);

  // ── Clean up a single peer connection ──────────────────────────────────────
  const closePeer = useCallback((peerId) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
      peerConnectionsRef.current.delete(peerId);
    }

    const audio = audioElementsRef.current.get(peerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      audioElementsRef.current.delete(peerId);
    }

    pendingCandidatesRef.current.delete(peerId);
  }, []);

  // ── Clean up all WebRTC connections & audio tracks ────────────────────────
  const cleanupAll = useCallback(() => {
    // Close all peer connections
    peerConnectionsRef.current.forEach((_, peerId) => closePeer(peerId));
    peerConnectionsRef.current.clear();
    audioElementsRef.current.clear();
    pendingCandidatesRef.current.clear();

    // Stop speaking detection
    if (speakingIntervalRef.current) {
      clearInterval(speakingIntervalRef.current);
      speakingIntervalRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    // Stop local mic stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    setIsInCall(false);
    setIsConnecting(false);
  }, [closePeer]);

  // ── Create or get RTCPeerConnection for a peer ─────────────────────────────
  const createPeerConnection = useCallback((peerId) => {
    if (peerConnectionsRef.current.has(peerId)) {
      return peerConnectionsRef.current.get(peerId);
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionsRef.current.set(peerId, pc);
    pendingCandidatesRef.current.set(peerId, []);

    // Add local audio tracks to the peer connection
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // Send ICE candidates to peer
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit("voice-call-signal", {
          to: peerId,
          signal: { type: "candidate", candidate: event.candidate },
        });
      }
    };

    // Receive remote audio stream
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (!remoteStream) return;

      let audio = audioElementsRef.current.get(peerId);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.style.display = "none";
        document.body.appendChild(audio);
        audioElementsRef.current.set(peerId, audio);
      }
      audio.srcObject = remoteStream;
      audio.muted = isDeafened;
      audio.play().catch((err) => {
        console.warn("[VoiceCall] auto-play error:", err.message);
      });
    };

    // Connection state logging & cleanup on disconnect
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        closePeer(peerId);
      }
    };

    return pc;
  }, [socket, isDeafened, closePeer]);

  // ── Setup Voice Activity (Speaking) Detection ──────────────────────────────
  const setupAudioAnalysis = useCallback((stream) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      speakingIntervalRef.current = setInterval(() => {
        if (!analyserRef.current || isMuted) {
          if (isSpeakingRef.current) {
            isSpeakingRef.current = false;
            socket?.emit("voice-call-speaking", { speaking: false });
          }
          return;
        }

        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const nowSpeaking = avg > 14; // Threshold for vocal energy

        if (nowSpeaking !== isSpeakingRef.current) {
          isSpeakingRef.current = nowSpeaking;
          socket?.emit("voice-call-speaking", { speaking: nowSpeaking });
        }
      }, 120);
    } catch (err) {
      console.warn("[VoiceCall] Audio analysis setup error:", err);
    }
  }, [socket, isMuted]);

  // ── Join Voice Call ────────────────────────────────────────────────────────
  const joinCall = useCallback(async () => {
    if (isInCall || isConnecting || !socket) return;
    setIsConnecting(true);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("WebRTC voice calling is not supported in this browser.");
      }

      // 1. Capture microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      localStreamRef.current = stream;
      setupAudioAnalysis(stream);

      // 2. Notify server that we joined the call
      socket.emit("voice-call-join");
      setIsInCall(true);
      toast.success("Joined voice call", { icon: "🎙️" });
    } catch (err) {
      console.error("[VoiceCall] Join error:", err);
      toast.error(`Microphone error: ${err.message || "Permission denied"}`);
      cleanupAll();
    } finally {
      setIsConnecting(false);
    }
  }, [isInCall, isConnecting, socket, setupAudioAnalysis, cleanupAll]);

  // ── Leave Voice Call ───────────────────────────────────────────────────────
  const leaveCall = useCallback(() => {
    if (!isInCall) return;
    if (socket) {
      socket.emit("voice-call-leave");
    }
    cleanupAll();
    toast("Left voice call", { icon: "👋" });
  }, [isInCall, socket, cleanupAll]);

  // ── Toggle Mute Microphone ─────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
    socket?.emit("voice-call-mute", { muted: nextMuted });
  }, [isMuted, socket]);

  // ── Toggle Deafen (Mute incoming sounds) ───────────────────────────────────
  const toggleDeafen = useCallback(() => {
    const nextDeafened = !isDeafened;
    setIsDeafened(nextDeafened);
    audioElementsRef.current.forEach((audio) => {
      audio.muted = nextDeafened;
    });
  }, [isDeafened]);

  // ── Socket event listeners ─────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // Receive current participants in call
    const handleParticipantsUpdate = (callUsers) => {
      setParticipants(Array.isArray(callUsers) ? callUsers : []);
    };

    // User joined room call
    const handleUserJoined = (user) => {
      setParticipants((prev) => {
        if (prev.some((p) => p.id === user.id)) return prev;
        return [...prev, user];
      });
      if (isInCall && user.id !== socket.id) {
        toast(`${user.name} joined the call`, { icon: "🎧" });
      }
    };

    // User left room call
    const handleUserLeft = ({ id }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== id));
      closePeer(id);
    };

    // User mute update
    const handleUserMuted = ({ id, muted }) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === id ? { ...p, muted } : p))
      );
    };

    // User speaking update
    const handleUserSpeaking = ({ id, speaking }) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === id ? { ...p, speaking } : p))
      );
    };

    // Existing call participants received upon joining call
    // As the new joiner, initiate offer to each existing participant
    const handleCallUsers = async (callUsers) => {
      if (!Array.isArray(callUsers)) return;
      for (const peer of callUsers) {
        if (peer.id === socket.id) continue;
        try {
          const pc = createPeerConnection(peer.id);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("voice-call-signal", {
            to: peer.id,
            signal: { type: "offer", sdp: offer },
          });
        } catch (err) {
          console.warn("[VoiceCall] Error creating offer to", peer.id, err);
        }
      }
    };

    // Handle incoming WebRTC signal (offer, answer, candidate)
    const handleCallSignal = async ({ from, signal }) => {
      if (!signal || !from) return;

      try {
        const pc = createPeerConnection(from);

        if (signal.type === "offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

          // Flush queued candidates
          const queued = pendingCandidatesRef.current.get(from) || [];
          for (const cand of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          }
          pendingCandidatesRef.current.set(from, []);

          // Create answer
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("voice-call-signal", {
            to: from,
            signal: { type: "answer", sdp: answer },
          });
        } else if (signal.type === "answer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

          // Flush queued candidates
          const queued = pendingCandidatesRef.current.get(from) || [];
          for (const cand of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          }
          pendingCandidatesRef.current.set(from, []);
        } else if (signal.type === "candidate") {
          if (!pc.remoteDescription) {
            // Queue candidate until remote description is set
            const queued = pendingCandidatesRef.current.get(from) || [];
            queued.push(signal.candidate);
            pendingCandidatesRef.current.set(from, queued);
          } else {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
          }
        }
      } catch (err) {
        console.warn("[VoiceCall] Signal handling error from", from, err);
      }
    };

    socket.on("voice-call-participants-update", handleParticipantsUpdate);
    socket.on("voice-call-user-joined", handleUserJoined);
    socket.on("voice-call-user-left", handleUserLeft);
    socket.on("voice-call-user-muted", handleUserMuted);
    socket.on("voice-call-user-speaking", handleUserSpeaking);
    socket.on("voice-call-users", handleCallUsers);
    socket.on("voice-call-signal", handleCallSignal);

    return () => {
      socket.off("voice-call-participants-update", handleParticipantsUpdate);
      socket.off("voice-call-user-joined", handleUserJoined);
      socket.off("voice-call-user-left", handleUserLeft);
      socket.off("voice-call-user-muted", handleUserMuted);
      socket.off("voice-call-user-speaking", handleUserSpeaking);
      socket.off("voice-call-users", handleCallUsers);
      socket.off("voice-call-signal", handleCallSignal);
    };
  }, [socket, isInCall, createPeerConnection, closePeer]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      cleanupAll();
    };
  }, [cleanupAll]);

  return {
    isInCall,
    isConnecting,
    isMuted,
    isDeafened,
    participants,
    joinCall,
    leaveCall,
    toggleMute,
    toggleDeafen,
    callCount: participants.length,
  };
}
