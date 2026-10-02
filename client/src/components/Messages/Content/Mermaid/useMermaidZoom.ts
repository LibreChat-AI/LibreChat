import { useState, useCallback, useEffect, useRef } from 'react';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

interface UseMermaidZoomOptions {
  containerRef?: React.RefObject<HTMLDivElement | null>;
  wheelDep?: unknown;
}

export default function useMermaidZoom({ containerRef, wheelDep }: UseMermaidZoomOptions = {}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((prev) => Math.min(Math.max(prev + delta, MIN_ZOOM), MAX_ZOOM));
  }, []);

  const panRef = useRef(pan);
  panRef.current = pan;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (e.button === 0 && target.tagName !== 'BUTTON' && !target.closest('button')) {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y };
    }
  }, []);

  useEffect(() => {
    if (!isPanning) {
      return;
    }
    const onMove = (e: MouseEvent) => {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
    };
    const onUp = () => setIsPanning(false);
    /* The diagram can be portaled into another window (the undocked artifacts
     * pane), where pointer events stay in that document and never reach the
     * opener's: drag and release must be observed where the canvas lives. */
    const eventDocument = containerRef?.current?.ownerDocument ?? document;
    eventDocument.addEventListener('mousemove', onMove);
    eventDocument.addEventListener('mouseup', onUp);
    return () => {
      eventDocument.removeEventListener('mousemove', onMove);
      eventDocument.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, isPanning]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        setZoom((prev) => Math.min(Math.max(prev + delta, MIN_ZOOM), MAX_ZOOM));
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [containerRef, wheelDep]);

  return {
    zoom,
    pan,
    isPanning,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handleWheel,
    handleMouseDown,
  };
}
