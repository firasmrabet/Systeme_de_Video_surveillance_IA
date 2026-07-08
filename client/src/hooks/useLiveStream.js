import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from '../context/SocketContext';

/**
 * useLiveStream — subscribes to a camera's live JPEG frames over WebSocket.
 *
 * Falls back gracefully to the /preview polling endpoint if WebSocket frames
 * don't arrive within 3s (server not pushing).
 *
 * @param {string} cameraId
 * @returns {object} { imgRef, stats, connected }
 *   - imgRef: attach to <img> to display the latest frame
 *   - stats: { fps, dropped, mode, lastFrameTs }
 *   - connected: true if WebSocket is open
 */
export function useLiveStream(cameraId, options = {}) {
  const { socket } = useSocket();
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ fps: 0, dropped: 0, mode: 'connecting', lastFrameTs: 0 });
  const imgRef = useRef(null);
  const lastBlobUrlRef = useRef(null);
  const frameTimesRef = useRef([]);
  const fallbackTimerRef = useRef(null);
  const stoppedRef = useRef(false);

  const onFrame = useCallback((jpegBuffer) => {
    if (stoppedRef.current) return;
    if (!imgRef.current) return;

    // Track FPS
    const now = Date.now();
    frameTimesRef.current.push(now);
    while (frameTimesRef.current.length > 0 && frameTimesRef.current[0] < now - 2000) {
      frameTimesRef.current.shift();
    }

    // Convert ArrayBuffer/Buffer to Blob
    const blob = new Blob([jpegBuffer], { type: 'image/jpeg' });
    if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    const url = URL.createObjectURL(blob);
    lastBlobUrlRef.current = url;
    imgRef.current.src = url;

    const fps = frameTimesRef.current.length / 2; // 2s window
    setStats((s) => ({ ...s, fps, mode: 'live', lastFrameTs: now }));
  }, []);

  // Start polling fallback if no live frame in 3s
  const startFallback = useCallback(async () => {
    if (stoppedRef.current) return;
    setStats((s) => ({ ...s, mode: 'polling' }));
    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        // Get auth token from localStorage
        const token = localStorage.getItem('token');
        if (!token) return;
        const baseURL = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;
        const res = await fetch(`${baseURL}/api/cameras/${cameraId}/preview?ts=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (stoppedRef.current || !imgRef.current) return;
        if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
        const url = URL.createObjectURL(blob);
        lastBlobUrlRef.current = url;
        imgRef.current.src = url;
        setStats((s) => ({ ...s, mode: 'polling', lastFrameTs: Date.now() }));
      } catch (e) { /* ignore */ }
    };
    poll();
    fallbackTimerRef.current = setInterval(poll, 1500);
  }, [cameraId]);

  useEffect(() => {
    if (!cameraId) return undefined;

    // If explicitly disabled (e.g. caller prefers native MJPEG), skip socket
    // subscription and polling fallback to avoid triggering server snapshot loops.
    if (options && options.enabled === false) {
      stoppedRef.current = true;
      setStats({ fps: 0, dropped: 0, mode: 'disabled', lastFrameTs: 0 });
      return () => {
        stoppedRef.current = true;
        if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
        if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
      };
    }

    stoppedRef.current = false;
    setStats({ fps: 0, dropped: 0, mode: 'connecting', lastFrameTs: 0 });

    if (!socket) {
      startFallback();
      return () => {
        stoppedRef.current = true;
        if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
        if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
      };
    }

    const onConnect = () => {
      setConnected(true);
      socket.emit('subscribe-live', cameraId);
      // If no live frame in 3s, start polling fallback
      setTimeout(() => {
        if (!stoppedRef.current && frameTimesRef.current.length === 0) {
          startFallback();
        }
      }, 3000);
    };
    const onDisconnect = () => setConnected(false);

    if (socket.connected) onConnect();
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('live-frame', onFrame);

    return () => {
      stoppedRef.current = true;
      try { socket.emit('unsubscribe-live', cameraId); } catch (_) {}
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('live-frame', onFrame);
      if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    };
  }, [cameraId, socket, onFrame, startFallback, options && options.enabled]);

  return { imgRef, stats, connected };
}
