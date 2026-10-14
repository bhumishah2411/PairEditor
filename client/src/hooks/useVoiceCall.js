/**
 * useVoiceCall – Production-ready multi-user WebRTC Voice & Video Calling hook.
 * Uses native RTCPeerConnection mesh with public STUN servers.
 * Relays signaling over the existing Socket.IO connection.
 * Features:
 *   - Live audio and video calling between room participants
 *   - Instant camera on/off toggling with hardware LED deactivation
 *   - Local preview stream & reactive remote streams map
 *   - Automatic ICE candidate queueing (zero dropped connections)
 *   - Microphone mute/unmute
 *   - Deafen support (mutes all incoming sound)
 *   - Local voice activity / volume analyzer for real-time speaking indicators
 *   - Detailed error reporting for permission denials and device errors
 *   - Clean disconnect & complete media stream teardown
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

function formatMediaError(err, requestedVideo) {
  const name = err.name || "";
  const msg = err.message || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return requestedVideo
      ? "Camera or microphone permission was denied. Please allow access in browser permissions."
      : "Microphone permission was denied. Please allow access in browser permissions.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return requestedVideo
      ? "No camera or microphone found on this device."
      : "No microphone found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your camera or microphone is in use by another application.";
  }
  if (name === "OverconstrainedError") {
    return "Device does not satisfy requested video/audio constraints.";
  }
  return msg || "Unable to access media devices.";
}

export default function useVoiceCall({ socket, roomId, currentUser }) {
  const [isInCall, setIsInCall] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [callMode, setCallMode] = useState("voice"); // "voice" | "video"
  const [participants, setParticipants] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState(new Map()); // peerId -> MediaStream

  // Refs for WebRTC resources
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map()); // socketId -> RTCPeerConnection
  const audioElementsRef = useRef(new Map()); // socketId -> HTMLAudioElement
  const remoteStreamsRef = useRef(new Map()); // socketId -> MediaStream
  const pendingCandidatesRef = useRef(new Map()); // socketId -> RTCIceCandidate[]
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const speakingIntervalRef = useRef(null);
  const isSpeakingRef = useRef(false);
  const isDeafenedRef = useRef(false);

  // Sync isDeafened ref for immediate use inside event listeners
  useEffect(() => {
    isDeafenedRef.current = isDeafened;
  }, [isDeafened]);

  // ── Clean up a single peer connection ──────────────────────────────────────
  const closePeer = useCallback((peerId) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
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
    remoteStreamsRef.current.delete(peerId);
    setRemoteStreams(new Map(remoteStreamsRef.current));
  }, []);

  // ── Clean up all WebRTC connections & media tracks ────────────────────────
  const cleanupAll = useCallback(() => {
    // Close all peer connections
    peerConnectionsRef.current.forEach((_, peerId) => closePeer(peerId));
    peerConnectionsRef.current.clear();
    audioElementsRef.current.clear();
    pendingCandidatesRef.current.clear();
    remoteStreamsRef.current.clear();
    setRemoteStreams(new Map());

    // Stop speaking detection
    if (speakingIntervalRef.current) {
      clearInterval(speakingIntervalRef.current);
      speakingIntervalRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    // Stop all local tracks (mic + camera)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);

    setIsInCall(false);
    setIsConnecting(false);
    setIsVideoEnabled(false);
    setCallMode("voice");
  }, [closePeer]);

  // ── Create or get RTCPeerConnection for a peer ─────────────────────────────
  const createPeerConnection = useCallback((peerId) => {
    if (peerConnectionsRef.current.has(peerId)) {
      return peerConnectionsRef.current.get(peerId);
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionsRef.current.set(peerId, pc);
    pendingCandidatesRef.current.set(peerId, []);

    // 1. Add local audio tracks if available
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // 2. Add local video track if available; otherwise add a video transceiver
    // so video m-line is pre-negotiated and replaceTrack works seamlessly later.
    const videoTracks = localStreamRef.current ? localStreamRef.current.getVideoTracks() : [];
    if (videoTracks.length > 0) {
      videoTracks.forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    } else {
      try {
        pc.addTransceiver("video", { direction: "sendrecv" });
      } catch (e) {
        console.warn("[VoiceCall] Transceiver add warning:", e);
      }
    }

    // 3. Send ICE candidates to peer
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit("voice-call-signal", {
          to: peerId,
          signal: { type: "candidate", candidate: event.candidate },
        });
      }
    };

    // 4. Receive remote audio/video tracks
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);

      let existing = remoteStreamsRef.current.get(peerId);
      if (!existing) {
        existing = stream;
        remoteStreamsRef.current.set(peerId, existing);
      } else {
        if (!existing.getTracks().includes(event.track)) {
          existing.addTrack(event.track);
        }
      }

      // Dedicated background audio element for smooth, echo-free incoming sound
      if (event.track.kind === "audio") {
        let audio = audioElementsRef.current.get(peerId);
        if (!audio) {
          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.playsInline = true;
          audio.style.display = "none";
          document.body.appendChild(audio);
          audioElementsRef.current.set(peerId, audio);
        }
        audio.srcObject = existing;
        audio.muted = isDeafenedRef.current;
        audio.play().catch((err) => {
          console.warn("[VoiceCall] auto-play error:", err.message);
        });
      }

      event.track.onended = () => {
        setRemoteStreams(new Map(remoteStreamsRef.current));
      };

      event.track.onmute = () => {
        setRemoteStreams(new Map(remoteStreamsRef.current));
      };

      event.track.onunmute = () => {
        setRemoteStreams(new Map(remoteStreamsRef.current));
      };

      setRemoteStreams(new Map(remoteStreamsRef.current));
    };

    // 5. Connection state logging & cleanup on disconnect
    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        closePeer(peerId);
      }
    };

    return pc;
  }, [socket, closePeer]);

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

  // ── Join Call (Voice or Video) ─────────────────────────────────────────────
  const joinCall = useCallback(async ({ video = false } = {}) => {
    if (isInCall || isConnecting || !socket) return;
    setIsConnecting(true);

    let stream = null;
    let actualVideo = false;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("WebRTC media calling is not supported in this browser.");
      }

      // Try capturing audio + optional video
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: video
            ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
            : false,
        });
        actualVideo = Boolean(video && stream.getVideoTracks().length > 0);
      } catch (err) {
        if (video) {
          console.warn("[VoiceCall] Video capture failed, trying audio-only fallback:", err);
          toast(formatMediaError(err, true) + " Joining with audio only...", { icon: "⚠️" });
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          actualVideo = false;
        } else {
          throw err;
        }
      }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsVideoEnabled(actualVideo);
      setCallMode(actualVideo ? "video" : "voice");
      setupAudioAnalysis(stream);

      // Notify server that we joined the call
      socket.emit("voice-call-join", { video: actualVideo });
      setIsInCall(true);

      if (actualVideo) {
        toast.success("Joined video call", { icon: "📹" });
      } else {
        toast.success("Joined voice call", { icon: "🎙️" });
      }
    } catch (err) {
      console.error("[VoiceCall] Join error:", err);
      toast.error(formatMediaError(err, video));
      cleanupAll();
    } finally {
      setIsConnecting(false);
    }
  }, [isInCall, isConnecting, socket, setupAudioAnalysis, cleanupAll]);

  // Aliases for convenience
  const startVideoCall = useCallback(() => joinCall({ video: true }), [joinCall]);
  const startVoiceCall = useCallback(() => joinCall({ video: false }), [joinCall]);

  // ── Leave Call ─────────────────────────────────────────────────────────────
  const leaveCall = useCallback(() => {
    if (!isInCall) return;
    if (socket) {
      socket.emit("voice-call-leave");
    }
    cleanupAll();
    toast("Left call", { icon: "👋" });
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

  // ── Toggle Camera / Video ──────────────────────────────────────────────────
  const toggleVideo = useCallback(async () => {
    if (!isInCall) return;

    if (isVideoEnabled) {
      // 1. Turn camera OFF
      if (localStreamRef.current) {
        localStreamRef.current.getVideoTracks().forEach((track) => {
          track.stop();
          localStreamRef.current.removeTrack(track);
        });
      }

      // Replace track on all existing peer connections with null
      peerConnectionsRef.current.forEach((pc) => {
        const sender = pc
          .getSenders()
          .find((s) => s.track?.kind === "video" || s.kind === "video");
        if (sender) {
          sender.replaceTrack(null).catch((e) => console.warn(e));
        }
      });

      setIsVideoEnabled(false);
      setLocalStream(
        localStreamRef.current ? new MediaStream(localStreamRef.current.getTracks()) : null
      );
      socket?.emit("voice-call-video", { video: false });
      toast("Camera turned off", { icon: "📷" });
    } else {
      // 2. Turn camera ON
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        });
        const newTrack = camStream.getVideoTracks()[0];
        if (!newTrack) throw new Error("No video track found.");

        if (!localStreamRef.current) {
          localStreamRef.current = new MediaStream();
        }
        localStreamRef.current.addTrack(newTrack);

        // Update senders on all active peer connections
        for (const [peerId, pc] of peerConnectionsRef.current.entries()) {
          const sender = pc
            .getSenders()
            .find((s) => s.track?.kind === "video" || s.kind === "video");
          if (sender) {
            await sender.replaceTrack(newTrack).catch((e) => console.warn(e));
          } else {
            pc.addTrack(newTrack, localStreamRef.current);
            // Trigger renegotiation if needed
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              socket?.emit("voice-call-signal", {
                to: peerId,
                signal: { type: "offer", sdp: offer },
              });
            } catch (err) {
              console.warn("[VoiceCall] Offer after camera-on error:", err);
            }
          }
        }

        setIsVideoEnabled(true);
        setCallMode("video");
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        socket?.emit("voice-call-video", { video: true });
        toast.success("Camera turned on", { icon: "📹" });
      } catch (err) {
        console.error("[VoiceCall] Camera toggle error:", err);
        toast.error(formatMediaError(err, true));
      }
    }
  }, [isInCall, isVideoEnabled, socket]);

  // ── Toggle Deafen (Mute incoming sounds) ───────────────────────────────────
  const toggleDeafen = useCallback(() => {
    const nextDeafened = !isDeafened;
    setIsDeafened(nextDeafened);
    isDeafenedRef.current = nextDeafened;
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
        toast(`${user.name} joined the call`, { icon: user.video ? "📹" : "🎧" });
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

    // User video status update
    const handleUserVideo = ({ id, video }) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === id ? { ...p, video: Boolean(video) } : p))
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
    socket.on("voice-call-user-video", handleUserVideo);
    socket.on("voice-call-user-speaking", handleUserSpeaking);
    socket.on("voice-call-users", handleCallUsers);
    socket.on("voice-call-signal", handleCallSignal);

    return () => {
      socket.off("voice-call-participants-update", handleParticipantsUpdate);
      socket.off("voice-call-user-joined", handleUserJoined);
      socket.off("voice-call-user-left", handleUserLeft);
      socket.off("voice-call-user-muted", handleUserMuted);
      socket.off("voice-call-user-video", handleUserVideo);
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
    isVideoEnabled,
    callMode,
    participants,
    localStream,
    remoteStreams,
    joinCall,
    startVideoCall,
    startVoiceCall,
    leaveCall,
    toggleMute,
    toggleVideo,
    toggleDeafen,
    callCount: participants.length,
  };
}
