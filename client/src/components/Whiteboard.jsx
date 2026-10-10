/**
 * Whiteboard – Real-time collaborative developer whiteboard.
 * Supports:
 *  - Freehand Pen & Highlighter
 *  - Architecture shapes: Rectangle (Service/DB), Diamond (Decision), Circle (Node/State), Arrow, Line
 *  - Text annotations with inline input
 *  - Move / Select tool to rearrange architecture elements
 *  - Eraser tool (click or swipe to delete)
 *  - Live collaborator cursor tracking with name badges
 *  - Live peer stroke streaming
 *  - Grid backdrop (Developer dot grid)
 *  - Zoom & Pan (infinite canvas feel)
 *  - Undo / Redo history
 *  - Export diagram as high-resolution PNG
 */
import { useState, useRef, useEffect, useCallback } from "react";
import {
  MousePointer,
  PenTool,
  Highlighter,
  Square,
  Circle,
  Diamond,
  ArrowRight,
  Minus,
  Type,
  Eraser,
  Hand,
  Undo2,
  Redo2,
  Trash2,
  Download,
  Grid,
  ZoomIn,
  ZoomOut,
  Maximize2,
  HelpCircle,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";

// ── Developer Color Palette ──────────────────────────────────────────────────
const PALETTE = [
  { label: "White / Paper", value: "#EDEFF2" },
  { label: "Signal Green",  value: "#6FE3A6" },
  { label: "Sky Cyan",      value: "#45B7D1" },
  { label: "Amber Yellow",  value: "#FECA57" },
  { label: "Coral Red",     value: "#FF6B6B" },
  { label: "Electric Iris", value: "#A29BFE" },
  { label: "Neon Pink",     value: "#FF9FF3" },
  { label: "Warm Orange",   value: "#FF9F43" },
];

const STROKE_WIDTHS = [
  { label: "Fine",   value: 2 },
  { label: "Medium", value: 4 },
  { label: "Bold",   value: 8 },
];

export default function Whiteboard({
  roomId,
  currentUser,
  elements = [],
  onChange,
  onDrawStep,
  remoteLiveStroke,
  remoteCursors = {},
  onCursorMove,
  onClear,
  isDark = true,
}) {
  // ── Canvas state ──────────────────────────────────────────────────────────
  const containerRef = useRef(null);
  const canvasRef    = useRef(null);

  // Active drawing tool
  const [tool, setTool]               = useState("pen"); // pen, highlighter, rectangle, diamond, circle, arrow, line, text, eraser, select, hand
  const [color, setColor]             = useState("#6FE3A6");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [showGrid, setShowGrid]       = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Zoom & Pan
  const [zoom, setZoom]               = useState(1);
  const [pan, setPan]                 = useState({ x: 0, y: 0 });
  const isPanningRef                  = useRef(false);
  const panStartRef                   = useRef({ x: 0, y: 0 });

  // History (Undo / Redo)
  const historyRef                    = useRef([elements]);
  const historyIndexRef               = useRef(0);
  const [canUndo, setCanUndo]         = useState(false);
  const [canRedo, setCanRedo]         = useState(false);

  // Active interaction
  const isDrawingRef                  = useRef(false);
  const currentElementRef             = useRef(null);
  const selectedElementIdRef          = useRef(null);
  const dragStartRef                  = useRef({ x: 0, y: 0 });
  const lastDrawEmitRef               = useRef(0);
  const lastCursorEmitRef             = useRef(0);

  // Text tool inline input
  const [textInput, setTextInput]     = useState(null); // { x, y, screenX, screenY, value: "" }
  const textInputRef                  = useRef(null);

  // ── Sync incoming elements with history stack ──────────────────────────────
  useEffect(() => {
    // If elements changed from outside (e.g. remote peer update)
    if (elements !== historyRef.current[historyIndexRef.current]) {
      historyRef.current = [...historyRef.current.slice(0, historyIndexRef.current + 1), elements];
      historyIndexRef.current = historyRef.current.length - 1;
      setCanUndo(historyIndexRef.current > 0);
      setCanRedo(false);
    }
  }, [elements]);

  // ── Update elements with undo/redo capability ──────────────────────────────
  const commitElements = useCallback(
    (newElements) => {
      onChange?.(newElements);
      const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), newElements];
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
      setCanUndo(historyIndexRef.current > 0);
      setCanRedo(false);
    },
    [onChange]
  );

  const handleUndo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current -= 1;
      const prev = historyRef.current[historyIndexRef.current] || [];
      onChange?.(prev);
      setCanUndo(historyIndexRef.current > 0);
      setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    }
  }, [onChange]);

  const handleRedo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current += 1;
      const next = historyRef.current[historyIndexRef.current] || [];
      onChange?.(next);
      setCanUndo(historyIndexRef.current > 0);
      setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    }
  }, [onChange]);

  // ── Coordinate conversion ──────────────────────────────────────────────────
  const getCanvasCoords = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom]
  );

  // ── Element Hit Testing ────────────────────────────────────────────────────
  const hitTestElement = useCallback((elem, x, y) => {
    const threshold = 10;
    if (elem.type === "rectangle" || elem.type === "diamond") {
      const minX = Math.min(elem.x, elem.x + elem.width);
      const maxX = Math.max(elem.x, elem.x + elem.width);
      const minY = Math.min(elem.y, elem.y + elem.height);
      const maxY = Math.max(elem.y, elem.y + elem.height);
      return x >= minX - threshold && x <= maxX + threshold && y >= minY - threshold && y <= maxY + threshold;
    }
    if (elem.type === "circle") {
      const rx = Math.abs(elem.radiusX);
      const ry = Math.abs(elem.radiusY);
      const dx = (x - elem.x) / (rx + threshold);
      const dy = (y - elem.y) / (ry + threshold);
      return dx * dx + dy * dy <= 1.2;
    }
    if (elem.type === "line" || elem.type === "arrow") {
      const { startX, startY, endX, endY } = elem;
      const dist = distToSegment({ x, y }, { x: startX, y: startY }, { x: endX, y: endY });
      return dist <= threshold;
    }
    if (elem.type === "pen" || elem.type === "highlighter") {
      if (!elem.points) return false;
      return elem.points.some((p) => Math.hypot(p.x - x, p.y - y) <= threshold + (elem.strokeWidth || 4));
    }
    if (elem.type === "text") {
      const w = (elem.text?.length || 1) * 10;
      const h = 24;
      return x >= elem.x - threshold && x <= elem.x + w + threshold && y >= elem.y - h - threshold && y <= elem.y + threshold;
    }
    return false;
  }, []);

  // ── Canvas Rendering Engine ────────────────────────────────────────────────
  const drawElement = useCallback((ctx, elem, isSelected = false) => {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = elem.color || "#EDEFF2";
    ctx.fillStyle = elem.color || "#EDEFF2";
    ctx.lineWidth = elem.strokeWidth || 3;

    if (elem.type === "highlighter") {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = (elem.strokeWidth || 4) * 4;
    }

    if (elem.type === "pen" || elem.type === "highlighter") {
      if (elem.points && elem.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(elem.points[0].x, elem.points[0].y);
        for (let i = 1; i < elem.points.length; i++) {
          const xc = (elem.points[i - 1].x + elem.points[i].x) / 2;
          const yc = (elem.points[i - 1].y + elem.points[i].y) / 2;
          ctx.quadraticCurveTo(elem.points[i - 1].x, elem.points[i - 1].y, xc, yc);
        }
        ctx.lineTo(elem.points[elem.points.length - 1].x, elem.points[elem.points.length - 1].y);
        ctx.stroke();
      } else if (elem.points && elem.points.length === 1) {
        ctx.beginPath();
        ctx.arc(elem.points[0].x, elem.points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (elem.type === "rectangle") {
      const x = Math.min(elem.x, elem.x + elem.width);
      const y = Math.min(elem.y, elem.y + elem.height);
      const w = Math.abs(elem.width);
      const h = Math.abs(elem.height);
      // Subtle background fill
      ctx.fillStyle = elem.color + "18";
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else if (elem.type === "diamond") {
      const cx = elem.x + elem.width / 2;
      const cy = elem.y + elem.height / 2;
      ctx.beginPath();
      ctx.moveTo(cx, elem.y);
      ctx.lineTo(elem.x + elem.width, cy);
      ctx.lineTo(cx, elem.y + elem.height);
      ctx.lineTo(elem.x, cy);
      ctx.closePath();
      ctx.fillStyle = elem.color + "18";
      ctx.fill();
      ctx.stroke();
    } else if (elem.type === "circle") {
      const rx = Math.abs(elem.radiusX);
      const ry = Math.abs(elem.radiusY);
      ctx.beginPath();
      ctx.ellipse(elem.x, elem.y, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      ctx.fillStyle = elem.color + "18";
      ctx.fill();
      ctx.stroke();
    } else if (elem.type === "line") {
      ctx.beginPath();
      ctx.moveTo(elem.startX, elem.startY);
      ctx.lineTo(elem.endX, elem.endY);
      ctx.stroke();
    } else if (elem.type === "arrow") {
      ctx.beginPath();
      ctx.moveTo(elem.startX, elem.startY);
      ctx.lineTo(elem.endX, elem.endY);
      ctx.stroke();

      // Arrowhead
      const angle = Math.atan2(elem.endY - elem.startY, elem.endX - elem.startX);
      const headLen = Math.max(12, elem.strokeWidth * 3.5);
      ctx.beginPath();
      ctx.moveTo(elem.endX, elem.endY);
      ctx.lineTo(
        elem.endX - headLen * Math.cos(angle - Math.PI / 6),
        elem.endY - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        elem.endX - headLen * Math.cos(angle + Math.PI / 6),
        elem.endY - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fillStyle = elem.color;
      ctx.fill();
    } else if (elem.type === "text") {
      ctx.font = `600 ${elem.fontSize || 16}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = elem.color || "#EDEFF2";
      ctx.fillText(elem.text || "", elem.x, elem.y);
    }

    // Selection bounding box highlight
    if (isSelected) {
      ctx.strokeStyle = "#6FE3A6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      const bounds = getElementBounds(elem);
      ctx.strokeRect(bounds.x - 6, bounds.y - 6, bounds.w + 12, bounds.h + 12);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }, []);

  // ── Render Entire Canvas ───────────────────────────────────────────────────
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    // Reset & clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = isDark ? "#10141A" : "#F6F7F5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Apply viewport transform (pan & zoom)
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, pan.x * dpr, pan.y * dpr);

    // Draw Developer Dot Grid
    if (showGrid) {
      const gridSize = 28;
      const startX = -pan.x / zoom;
      const startY = -pan.y / zoom;
      const endX = startX + width / zoom;
      const endY = startY + height / zoom;

      const firstX = Math.floor(startX / gridSize) * gridSize;
      const firstY = Math.floor(startY / gridSize) * gridSize;

      ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.14)";
      for (let x = firstX; x <= endX; x += gridSize) {
        for (let y = firstY; y <= endY; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2 / zoom, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Draw all committed elements
    elements.forEach((elem) => {
      const isSelected = selectedElementIdRef.current === elem.id;
      drawElement(ctx, elem, isSelected);
    });

    // Draw in-progress element
    if (currentElementRef.current) {
      drawElement(ctx, currentElementRef.current, false);
    }

    // Draw live peer stroke (streaming)
    if (remoteLiveStroke?.stroke) {
      drawElement(ctx, remoteLiveStroke.stroke, false);
    }
  }, [elements, zoom, pan, showGrid, isDark, drawElement, remoteLiveStroke]);

  // ── Resize Observer for Crisp High-DPI Display ─────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      renderCanvas();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    return () => observer.disconnect();
  }, [renderCanvas]);

  // Re-render when dependencies change
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // ── Mouse & Touch Event Handlers ───────────────────────────────────────────
  const handlePointerDown = (e) => {
    if (e.button === 1 || tool === "hand" || e.spaceKey) {
      // Middle click or hand tool: pan
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      return;
    }

    if (e.button !== 0) return; // only left click

    const coords = getCanvasCoords(e);

    // Text tool
    if (tool === "text") {
      const rect = canvasRef.current.getBoundingClientRect();
      setTextInput({
        x: coords.x,
        y: coords.y,
        screenX: e.clientX - rect.left,
        screenY: e.clientY - rect.top,
        value: "",
      });
      return;
    }

    // Select tool
    if (tool === "select") {
      const hit = [...elements].reverse().find((el) => hitTestElement(el, coords.x, coords.y));
      if (hit) {
        selectedElementIdRef.current = hit.id;
        dragStartRef.current = { x: coords.x, y: coords.y };
        isDrawingRef.current = true;
      } else {
        selectedElementIdRef.current = null;
      }
      renderCanvas();
      return;
    }

    // Eraser tool
    if (tool === "eraser") {
      isDrawingRef.current = true;
      const filtered = elements.filter((el) => !hitTestElement(el, coords.x, coords.y));
      if (filtered.length !== elements.length) {
        commitElements(filtered);
      }
      return;
    }

    // Drawing tools
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    isDrawingRef.current = true;
    const elemId = uuidv4();

    if (tool === "pen" || tool === "highlighter") {
      currentElementRef.current = {
        id: elemId,
        type: tool,
        points: [{ x: coords.x, y: coords.y }],
        color,
        strokeWidth: tool === "highlighter" ? strokeWidth * 3 : strokeWidth,
      };
    } else if (tool === "rectangle") {
      currentElementRef.current = {
        id: elemId,
        type: "rectangle",
        x: coords.x,
        y: coords.y,
        width: 0,
        height: 0,
        color,
        strokeWidth,
      };
    } else if (tool === "diamond") {
      currentElementRef.current = {
        id: elemId,
        type: "diamond",
        x: coords.x,
        y: coords.y,
        width: 0,
        height: 0,
        color,
        strokeWidth,
      };
    } else if (tool === "circle") {
      currentElementRef.current = {
        id: elemId,
        type: "circle",
        x: coords.x,
        y: coords.y,
        radiusX: 0,
        radiusY: 0,
        color,
        strokeWidth,
      };
    } else if (tool === "line" || tool === "arrow") {
      currentElementRef.current = {
        id: elemId,
        type: tool,
        startX: coords.x,
        startY: coords.y,
        endX: coords.x,
        endY: coords.y,
        color,
        strokeWidth,
      };
    }

    renderCanvas();
  };

  const handlePointerMove = (e) => {
    // Broadcast cursor position to peers (throttled ~40ms)
    const coords = getCanvasCoords(e);
    const now = Date.now();
    if (now - lastCursorEmitRef.current > 40) {
      lastCursorEmitRef.current = now;
      onCursorMove?.({ x: coords.x, y: coords.y });
    }

    // Handle Pan
    if (isPanningRef.current) {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
      return;
    }

    if (!isDrawingRef.current) return;

    // Handle Eraser drag-over
    if (tool === "eraser") {
      const filtered = elements.filter((el) => !hitTestElement(el, coords.x, coords.y));
      if (filtered.length !== elements.length) {
        commitElements(filtered);
      }
      return;
    }

    // Handle Select Move drag
    if (tool === "select" && selectedElementIdRef.current) {
      const dx = coords.x - dragStartRef.current.x;
      const dy = coords.y - dragStartRef.current.y;
      dragStartRef.current = { x: coords.x, y: coords.y };

      const updated = elements.map((el) => {
        if (el.id !== selectedElementIdRef.current) return el;
        return moveElement(el, dx, dy);
      });
      commitElements(updated);
      return;
    }

    // Handle Active Drawing
    const curr = currentElementRef.current;
    if (!curr) return;

    if (curr.type === "pen" || curr.type === "highlighter") {
      curr.points.push({ x: coords.x, y: coords.y });
    } else if (curr.type === "rectangle" || curr.type === "diamond") {
      curr.width = coords.x - curr.x;
      curr.height = coords.y - curr.y;
    } else if (curr.type === "circle") {
      curr.radiusX = (coords.x - curr.x) / 2;
      curr.radiusY = (coords.y - curr.y) / 2;
    } else if (curr.type === "line" || curr.type === "arrow") {
      curr.endX = coords.x;
      curr.endY = coords.y;
    }

    // Stream live shape / stroke to peers in real time (throttled ~30ms) for ALL types!
    if (now - lastDrawEmitRef.current > 30) {
      lastDrawEmitRef.current = now;
      const clone = curr.points ? { ...curr, points: [...curr.points] } : { ...curr };
      onDrawStep?.(clone);
    }

    renderCanvas();
  };

  const handlePointerUp = (e) => {
    try {
      e?.currentTarget?.releasePointerCapture(e.pointerId);
    } catch {}

    if (isPanningRef.current) {
      isPanningRef.current = false;
      return;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    if (currentElementRef.current) {
      const finished = { ...currentElementRef.current };
      currentElementRef.current = null;
      commitElements([...elements, finished]);
      onDrawStep?.(null);
    }
  };

  // ── Wheel Zoom & Pan ───────────────────────────────────────────────────────
  const handleWheel = (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoom((z) => Math.min(3, Math.max(0.3, z * zoomFactor)));
    } else {
      // Pan
      setPan((p) => ({
        x: p.x - e.deltaX,
        y: p.y - e.deltaY,
      }));
    }
  };

  // ── Commit Text Annotation ─────────────────────────────────────────────────
  const handleCommitText = () => {
    if (textInput && textInput.value.trim()) {
      const newElem = {
        id: uuidv4(),
        type: "text",
        x: textInput.x,
        y: textInput.y,
        text: textInput.value.trim(),
        color,
        fontSize: Math.max(14, strokeWidth * 5),
      };
      commitElements([...elements, newElem]);
    }
    setTextInput(null);
  };

  // ── Keyboard Shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      } else if (e.key.toLowerCase() === "v") {
        setTool("select");
      } else if (e.key.toLowerCase() === "p") {
        setTool("pen");
      } else if (e.key.toLowerCase() === "h") {
        setTool("highlighter");
      } else if (e.key.toLowerCase() === "r") {
        setTool("rectangle");
      } else if (e.key.toLowerCase() === "d") {
        setTool("diamond");
      } else if (e.key.toLowerCase() === "c") {
        setTool("circle");
      } else if (e.key.toLowerCase() === "a") {
        setTool("arrow");
      } else if (e.key.toLowerCase() === "l") {
        setTool("line");
      } else if (e.key.toLowerCase() === "t") {
        setTool("text");
      } else if (e.key.toLowerCase() === "e") {
        setTool("eraser");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedElementIdRef.current) {
          commitElements(elements.filter((el) => el.id !== selectedElementIdRef.current));
          selectedElementIdRef.current = null;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo, commitElements, elements]);

  // ── Export Whiteboard as PNG ───────────────────────────────────────────────
  const handleExportPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create offscreen canvas with nice padding and background
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext("2d");

    // Fill theme background
    ctx.fillStyle = isDark ? "#10141A" : "#FFFFFF";
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // Draw grid if active
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, pan.x * dpr, pan.y * dpr);

    if (showGrid) {
      const gridSize = 28;
      ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.12)";
      for (let x = 0; x <= canvas.width / dpr; x += gridSize) {
        for (let y = 0; y <= canvas.height / dpr; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Render all elements
    elements.forEach((elem) => drawElement(ctx, elem, false));

    // Watermark
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = "500 13px 'JetBrains Mono', monospace";
    ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.4)";
    ctx.fillText(`PairEditor Architecture Diagram • Room: ${roomId}`, 20, exportCanvas.height - 20);

    // Trigger download
    const url = exportCanvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `pairEditor-diagram-${roomId || "room"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ── Clear Canvas Handler ───────────────────────────────────────────────────
  const handleClearBoard = () => {
    if (elements.length === 0) return;
    if (window.confirm("Clear all drawings and diagrams on the whiteboard for this room?")) {
      onClear?.();
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full select-none overflow-hidden bg-canvas cursor-crosshair font-sans"
      onWheel={handleWheel}
    >
      {/* ── Main HTML5 Canvas ── */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="w-full h-full block touch-none"
      />

      {/* ── Remote Collaborators' Live Cursors ── */}
      {Object.entries(remoteCursors).map(([uid, c]) => {
        if (!c || c.x == null || c.y == null) return null;
        // Transform canvas coordinate to screen coordinate
        const screenX = c.x * zoom + pan.x;
        const screenY = c.y * zoom + pan.y;

        return (
          <div
            key={uid}
            className="absolute pointer-events-none transition-all duration-75 z-20"
            style={{ transform: `translate(${screenX}px, ${screenY}px)` }}
          >
            {/* Custom pencil/pointer SVG icon in collaborator's color */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              style={{ color: c.color || "#6FE3A6" }}
              className="drop-shadow-md"
            >
              <path
                d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z"
                fill="currentColor"
                stroke="#10141A"
                strokeWidth="1.2"
              />
            </svg>
            {/* Name tag pill */}
            <span
              className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold text-canvas shadow-lg ml-3 -mt-2 inline-block whitespace-nowrap"
              style={{ backgroundColor: c.color || "#6FE3A6" }}
            >
              {c.userName || "Peer"}
            </span>
          </div>
        );
      })}

      {/* ── Inline Text Input Overlay ── */}
      {textInput && (
        <div
          className="absolute z-30"
          style={{ transform: `translate(${textInput.screenX}px, ${textInput.screenY}px)` }}
        >
          <input
            ref={textInputRef}
            autoFocus
            type="text"
            value={textInput.value}
            onChange={(e) => setTextInput((prev) => ({ ...prev, value: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCommitText();
              if (e.key === "Escape") setTextInput(null);
            }}
            onBlur={handleCommitText}
            placeholder="Type note or service name…"
            className="bg-panel border-2 rounded px-2.5 py-1 text-sm font-mono shadow-2xl outline-none"
            style={{ borderColor: color, color: color }}
          />
        </div>
      )}

      {/* ── Floating Primary Tool Dock (Top / Center) ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 p-1.5 rounded-xl panel-glass shadow-2xl border border-line">
        {/* Tool buttons */}
        <ToolButton
          active={tool === "select"}
          onClick={() => setTool("select")}
          icon={<MousePointer size={15} />}
          title="Select & Move (V)"
        />
        <ToolButton
          active={tool === "pen"}
          onClick={() => setTool("pen")}
          icon={<PenTool size={15} />}
          title="Pen (P)"
        />
        <ToolButton
          active={tool === "highlighter"}
          onClick={() => setTool("highlighter")}
          icon={<Highlighter size={15} />}
          title="Highlighter (H)"
        />

        <div className="h-5 w-px bg-line mx-0.5" />

        {/* Architectural Shapes */}
        <ToolButton
          active={tool === "rectangle"}
          onClick={() => setTool("rectangle")}
          icon={<Square size={15} />}
          title="Service / Box (R)"
        />
        <ToolButton
          active={tool === "diamond"}
          onClick={() => setTool("diamond")}
          icon={<Diamond size={15} />}
          title="Decision / Gateway (D)"
        />
        <ToolButton
          active={tool === "circle"}
          onClick={() => setTool("circle")}
          icon={<Circle size={15} />}
          title="Node / State (C)"
        />
        <ToolButton
          active={tool === "arrow"}
          onClick={() => setTool("arrow")}
          icon={<ArrowRight size={15} />}
          title="Flow Arrow (A)"
        />
        <ToolButton
          active={tool === "line"}
          onClick={() => setTool("line")}
          icon={<Minus size={15} />}
          title="Connector Line (L)"
        />
        <ToolButton
          active={tool === "text"}
          onClick={() => setTool("text")}
          icon={<Type size={15} />}
          title="Text Note (T)"
        />

        <div className="h-5 w-px bg-line mx-0.5" />

        <ToolButton
          active={tool === "eraser"}
          onClick={() => setTool("eraser")}
          icon={<Eraser size={15} />}
          title="Eraser (E)"
        />
        <ToolButton
          active={tool === "hand"}
          onClick={() => setTool("hand")}
          icon={<Hand size={15} />}
          title="Pan Hand (Space + Drag)"
        />
      </div>

      {/* ── Floating Palette & Properties Bar (Left Side) ── */}
      <div className="absolute top-16 left-3.5 z-30 flex flex-col gap-2 p-2 rounded-xl panel-glass shadow-2xl border border-line">
        {/* Colors */}
        <div className="flex flex-wrap gap-1.5 max-w-[104px]">
          {PALETTE.map((p) => (
            <button
              key={p.value}
              onClick={() => setColor(p.value)}
              className={`w-5 h-5 rounded transition-all flex items-center justify-center ${
                color === p.value
                  ? "ring-2 ring-signal scale-110 shadow-md"
                  : "hover:scale-105 opacity-80 hover:opacity-100"
              }`}
              style={{ backgroundColor: p.value }}
              title={p.label}
            />
          ))}
        </div>

        <div className="h-px bg-line" />

        {/* Stroke Widths */}
        <div className="flex items-center justify-between gap-1">
          {STROKE_WIDTHS.map((s) => (
            <button
              key={s.value}
              onClick={() => setStrokeWidth(s.value)}
              className={`flex-1 py-1 rounded text-[10px] font-mono transition-colors text-center ${
                strokeWidth === s.value
                  ? "bg-signal text-canvas font-bold"
                  : "text-paper-muted hover:text-paper hover:bg-panel-raised"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── History & Export Actions Dock (Top Right) ── */}
      <div className="absolute top-4 right-4 z-30 flex items-center gap-1.5 p-1.5 rounded-xl panel-glass shadow-2xl border border-line">
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className="p-1.5 rounded text-paper-muted hover:text-paper hover:bg-panel-raised transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={15} />
        </button>
        <button
          onClick={handleRedo}
          disabled={!canRedo}
          className="p-1.5 rounded text-paper-muted hover:text-paper hover:bg-panel-raised transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Redo (Ctrl+Y)"
        >
          <Redo2 size={15} />
        </button>

        <div className="h-4 w-px bg-line mx-0.5" />

        <button
          onClick={() => setShowGrid((g) => !g)}
          className={`p-1.5 rounded transition-colors ${
            showGrid ? "text-signal bg-signal/10" : "text-paper-muted hover:text-paper hover:bg-panel-raised"
          }`}
          title="Toggle Dot Grid"
        >
          <Grid size={15} />
        </button>

        <button
          onClick={handleExportPNG}
          className="p-1.5 rounded text-paper-muted hover:text-paper hover:bg-panel-raised transition-colors"
          title="Export Diagram as PNG"
        >
          <Download size={15} />
        </button>

        <button
          onClick={handleClearBoard}
          className="p-1.5 rounded text-danger/80 hover:text-danger hover:bg-danger/10 transition-colors"
          title="Clear Board"
        >
          <Trash2 size={15} />
        </button>

        <button
          onClick={() => setShowShortcuts((s) => !s)}
          className={`p-1.5 rounded transition-colors ${
            showShortcuts ? "text-signal bg-signal/10" : "text-paper-muted hover:text-paper hover:bg-panel-raised"
          }`}
          title="Keyboard Shortcuts"
        >
          <HelpCircle size={15} />
        </button>
      </div>

      {/* ── Bottom Status & Zoom Controls Bar ── */}
      <div className="absolute bottom-4 left-4 z-30 flex items-center gap-2 p-1.5 rounded-lg panel-glass shadow-xl border border-line text-xs font-mono text-paper-muted">
        <button
          onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}
          className="p-1 hover:text-paper rounded hover:bg-panel-raised transition-colors"
          title="Zoom Out"
        >
          <ZoomOut size={13} />
        </button>
        <span
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="cursor-pointer hover:text-signal px-1 select-none"
          title="Click to reset zoom (100%)"
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
          className="p-1 hover:text-paper rounded hover:bg-panel-raised transition-colors"
          title="Zoom In"
        >
          <ZoomIn size={13} />
        </button>
        <button
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          className="p-1 hover:text-paper rounded hover:bg-panel-raised transition-colors"
          title="Reset View"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      {/* ── Shortcuts Modal ── */}
      {showShortcuts && (
        <div className="absolute top-16 right-4 z-40 p-4 rounded-xl panel-glass shadow-2xl border border-line w-72 text-xs font-mono space-y-2 text-paper">
          <div className="flex items-center justify-between pb-1.5 border-b border-line">
            <span className="font-semibold text-signal">Shortcuts & Tools</span>
            <button onClick={() => setShowShortcuts(false)} className="text-paper-faint hover:text-paper">✕</button>
          </div>
          <div className="space-y-1 text-paper-muted text-[11px]">
            <div className="flex justify-between"><span>Pen / Freehand</span><span className="text-signal">P</span></div>
            <div className="flex justify-between"><span>Highlighter</span><span className="text-signal">H</span></div>
            <div className="flex justify-between"><span>Box / Service</span><span className="text-signal">R</span></div>
            <div className="flex justify-between"><span>Diamond / Logic</span><span className="text-signal">D</span></div>
            <div className="flex justify-between"><span>Circle / State</span><span className="text-signal">C</span></div>
            <div className="flex justify-between"><span>Arrow Connector</span><span className="text-signal">A</span></div>
            <div className="flex justify-between"><span>Text Note</span><span className="text-signal">T</span></div>
            <div className="flex justify-between"><span>Eraser</span><span className="text-signal">E</span></div>
            <div className="flex justify-between"><span>Select & Move</span><span className="text-signal">V</span></div>
            <div className="flex justify-between"><span>Pan Canvas</span><span className="text-signal">Space + Drag</span></div>
            <div className="flex justify-between"><span>Undo / Redo</span><span className="text-signal">Ctrl+Z / Ctrl+Y</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Floating Tool Button ─────────────────────────────────────────────────────
function ToolButton({ active, onClick, icon, title }) {
  return (
    <button
      onClick={onClick}
      className={`p-2 rounded-lg transition-all flex items-center justify-center ${
        active
          ? "bg-signal text-canvas shadow-md scale-105"
          : "text-paper-muted hover:text-paper hover:bg-panel-raised"
      }`}
      title={title}
    >
      {icon}
    </button>
  );
}

// ── Math Helpers ─────────────────────────────────────────────────────────────
function distToSegment(p, v, w) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

function getElementBounds(elem) {
  if (elem.type === "rectangle" || elem.type === "diamond") {
    return {
      x: Math.min(elem.x, elem.x + elem.width),
      y: Math.min(elem.y, elem.y + elem.height),
      w: Math.abs(elem.width),
      h: Math.abs(elem.height),
    };
  }
  if (elem.type === "circle") {
    return {
      x: elem.x - Math.abs(elem.radiusX),
      y: elem.y - Math.abs(elem.radiusY),
      w: Math.abs(elem.radiusX) * 2,
      h: Math.abs(elem.radiusY) * 2,
    };
  }
  if (elem.type === "line" || elem.type === "arrow") {
    return {
      x: Math.min(elem.startX, elem.endX),
      y: Math.min(elem.startY, elem.endY),
      w: Math.abs(elem.endX - elem.startX),
      h: Math.abs(elem.endY - elem.startY),
    };
  }
  if (elem.type === "text") {
    return {
      x: elem.x,
      y: elem.y - 20,
      w: (elem.text?.length || 1) * 10,
      h: 24,
    };
  }
  if (elem.points && elem.points.length > 0) {
    const xs = elem.points.map((p) => p.x);
    const ys = elem.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function moveElement(elem, dx, dy) {
  if (elem.type === "rectangle" || elem.type === "diamond" || elem.type === "circle" || elem.type === "text") {
    return { ...elem, x: elem.x + dx, y: elem.y + dy };
  }
  if (elem.type === "line" || elem.type === "arrow") {
    return {
      ...elem,
      startX: elem.startX + dx,
      startY: elem.startY + dy,
      endX: elem.endX + dx,
      endY: elem.endY + dy,
    };
  }
  if (elem.points) {
    return {
      ...elem,
      points: elem.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    };
  }
  return elem;
}
