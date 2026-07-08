import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from '../context/SocketContext';

export function useCanvasStream(cameraId, options = {}) {
  const { socket } = useSocket();
  const canvasRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ fps: 0, mode: 'connecting', error: null });

  const frameQueueRef = useRef([]);
  const rafIdRef = useRef(null);
  const frameTimesRef = useRef([]);
  const stoppedRef = useRef(false);
  const fallbackTimerRef = useRef(null);
  const mjpegAbortRef = useRef(null);
  const lastFrameTsRef = useRef(0);

  const paintLoop = useCallback(() => {
    if (stoppedRef.current) return;
    const queue = frameQueueRef.current;
    if (queue.length === 0) {
      rafIdRef.current = requestAnimationFrame(paintLoop);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      rafIdRef.current = requestAnimationFrame(paintLoop);
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      rafIdRef.current = requestAnimationFrame(paintLoop);
      return;
    }

    const bitmap = queue[queue.length - 1];
    frameQueueRef.current = [];

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);

    const now = Date.now();
    frameTimesRef.current.push(now);
    while (frameTimesRef.current.length > 0 && frameTimesRef.current[0] < now - 2000) {
      frameTimesRef.current.shift();
    }
    const fps = frameTimesRef.current.length / 2;
    setStats((s) => ({ ...s, fps: Math.round(fps) }));

    bitmap.close();
    lastFrameTsRef.current = now;
    rafIdRef.current = requestAnimationFrame(paintLoop);
  }, []);

  const pushBitmap = useCallback(async (jpegBytes) => {
    if (stoppedRef.current) return;
    try {
      const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      frameQueueRef.current.push(bitmap);
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(paintLoop);
      }
    } catch (_) {}
  }, [paintLoop]);

  const startMjpegFallback = useCallback(async (mjpegUrl) => {
    if (stoppedRef.current || !mjpegUrl) return;
    setStats((s) => ({ ...s, mode: 'mjpeg' }));

    const controller = new AbortController();
    mjpegAbortRef.current = controller;

    try {
      const token = localStorage.getItem('token');
      const headers = { 'Accept': 'multipart/x-mixed-replace, image/jpeg' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(mjpegUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers,
        signal: controller.signal
      });
      if (!response.ok || !response.body) return;

      const ct = response.headers.get('content-type') || '';
      const boundaryMatch = ct.match(/boundary=([^;]+)/i);
      if (!boundaryMatch) return;

      const rawBoundary = boundaryMatch[1].trim();
      const boundary = rawBoundary.startsWith('--') ? rawBoundary : `--${rawBoundary}`;
      const boundaryBytes = new TextEncoder().encode(boundary);
      const dblCrlf = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);

      const findIndex = (haystack, needle, startFrom = 0) => {
        for (let i = startFrom; i <= haystack.length - needle.length; i++) {
          let match = true;
          for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) { match = false; break; }
          }
          if (match) return i;
        }
        return -1;
      };

      while (!stoppedRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const next = new Uint8Array(buffer.length + value.length);
          next.set(buffer, 0);
          next.set(value, buffer.length);
          buffer = next;
        }

        let safety = 8;
        while (safety-- > 0 && !stoppedRef.current) {
          const bIdx = findIndex(buffer, boundaryBytes, 0);
          if (bIdx < 0) break;
          let scan = bIdx + boundaryBytes.length;
          while (scan < buffer.length && (buffer[scan] === 0x0d || buffer[scan] === 0x0a)) scan++;
          const sepIdx = findIndex(buffer, dblCrlf, scan);
          if (sepIdx < 0) break;
          const bodyStart = sepIdx + 4;
          const nextBIdx = findIndex(buffer, boundaryBytes, bodyStart);
          if (nextBIdx < 0) break;
          let frameEnd = nextBIdx;
          while (frameEnd > bodyStart && (buffer[frameEnd - 1] === 0x0d || buffer[frameEnd - 1] === 0x0a)) {
            frameEnd--;
          }
          const frameLen = frameEnd - bodyStart;
          if (frameLen <= 0) { buffer = buffer.slice(sepIdx + 4); continue; }

          const jpegBytes = buffer.slice(bodyStart, frameEnd);
          if (jpegBytes.length >= 3 && jpegBytes[0] === 0xFF && jpegBytes[1] === 0xD8 && jpegBytes[2] === 0xFF) {
            let nextStart = frameEnd;
            while (nextStart + 1 < buffer.length && buffer[nextStart] === 0x0d && buffer[nextStart + 1] === 0x0a) {
              nextStart += 2;
              break;
            }
            buffer = buffer.slice(nextStart);
            await pushBitmap(jpegBytes);
          } else {
            buffer = buffer.slice(sepIdx + 4);
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setStats((s) => ({ ...s, mode: 'error', error: e.message }));
      }
    }
  }, [pushBitmap]);

  const startFallbackPoll = useCallback(() => {
    if (stoppedRef.current) return;
    setStats((s) => ({ ...s, mode: 'polling' }));
    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        const token = localStorage.getItem('token');
        if (!token) return;
        const baseURL = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;
        const res = await fetch(`${baseURL}/api/cameras/${cameraId}/preview?ts=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (stoppedRef.current) return;
        const buffer = await blob.arrayBuffer();
        await pushBitmap(new Uint8Array(buffer));
      } catch (_) {}
    };
    poll();
    fallbackTimerRef.current = setInterval(poll, 1500);
  }, [cameraId, pushBitmap]);

  useEffect(() => {
    if (!cameraId) return undefined;
    stoppedRef.current = false;
    setStats({ fps: 0, mode: 'connecting', error: null });
    setConnected(false);
    lastFrameTsRef.current = 0;

    if (!socket) {
      if (options.mjpegUrl) {
        startMjpegFallback(options.mjpegUrl);
      } else {
        startFallbackPoll();
      }
      return () => {
        stoppedRef.current = true;
        if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
        if (mjpegAbortRef.current) { mjpegAbortRef.current.abort(); mjpegAbortRef.current = null; }
        if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
        const q = frameQueueRef.current;
        for (const bmp of q) { try { bmp.close(); } catch (_) {} }
        frameQueueRef.current = [];
      };
    }

    const onConnect = () => {
      setConnected(true);
      socket.emit('subscribe-live', cameraId);
      setTimeout(() => {
        if (!stoppedRef.current && lastFrameTsRef.current === 0) {
          if (options.mjpegUrl) {
            startMjpegFallback(options.mjpegUrl);
          } else {
            startFallbackPoll();
          }
        }
      }, 3000);
    };
    const onDisconnect = () => setConnected(false);

    if (socket.connected) onConnect();
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('live-frame', pushBitmap);

    return () => {
      stoppedRef.current = true;
      try { socket.emit('unsubscribe-live', cameraId); } catch (_) {}
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('live-frame', pushBitmap);
      if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
      if (mjpegAbortRef.current) { mjpegAbortRef.current.abort(); mjpegAbortRef.current = null; }
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      const q = frameQueueRef.current;
      for (const bmp of q) { try { bmp.close(); } catch (_) {} }
      frameQueueRef.current = [];
    };
  }, [cameraId, socket, pushBitmap, startMjpegFallback, startFallbackPoll, options.mjpegUrl]);

  const restart = useCallback(() => {
    stoppedRef.current = true;
    if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    if (mjpegAbortRef.current) { mjpegAbortRef.current.abort(); mjpegAbortRef.current = null; }
    const q = frameQueueRef.current;
    for (const bmp of q) { try { bmp.close(); } catch (_) {} }
    frameQueueRef.current = [];
    lastFrameTsRef.current = 0;
  }, []);

  return { canvasRef, stats, connected, restart };
}
