import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { useSocket } from '../../context/SocketContext';
import { WebCodecsPlayer, attachLiveFrameSource } from './WebCodecsPlayer';

export { WebCodecsPlayer, attachLiveFrameSource };
import { CameraOff, Loader2 } from 'lucide-react';

const API_BASE = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

/**
 * LiveVideoPlayer — TikTok-quality live video using WebCodecs + H.264 + MSE.
 *
 * Subscribes to the server's live JPEG stream over Socket.IO, decodes each
 * JPEG, encodes to H.264, muxes to fMP4, and feeds to a <video> element
 * via MediaSource Extensions.
 *
 * Props:
 *   cameraId       — camera to stream
 *   fallback       — what to render while waiting for first frame or if WebCodecs unsupported
 *   className      — extra classes for the <video>
 *   style          — inline style for the <video>
 *   onFps          — callback(fps)
 *   onError        — callback(err)
 *   onState        — callback('starting'|'streaming'|'stopped'|'error'|'unsupported')
 *   onLoaded       — callback() once first frame is rendered
 *   initialSnapshot — URL to use as initial frame before first live frame
 *   bitrate        — H.264 bitrate in bps (default 1.5 Mbps)
 *   framerate      — target FPS (default 30)
 *
 * Imperative API (via ref):
 *   .stop()    — stop streaming
 *   .restart() — restart with fresh MediaSource
 *   .getStats() — { fps, width, height, encodeQueueSize, isOpen }
 */
const LiveVideoPlayer = forwardRef(function LiveVideoPlayer(props, ref) {
  const {
    cameraId,
    fallback,
    className = '',
    style,
    onFps,
    onError,
    onState,
    onLoaded,
    initialSnapshot,
    bitrate = 1_500_000,
    framerate = 30
  } = props;

  const { socket, subscribeLive, unsubscribeLive } = useSocket();
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const detachRef = useRef(null);

  const [state, setState] = useState('idle'); // idle | starting | streaming | stopped | error | unsupported
  const [errorMsg, setErrorMsg] = useState('');
  const [supported] = useState(() => WebCodecsPlayer.isSupported());

  // Expose imperative API
  useImperativeHandle(ref, () => ({
    stop: () => {
      if (playerRef.current) {
        playerRef.current.stop();
        playerRef.current = null;
      }
      if (detachRef.current) {
        detachRef.current();
        detachRef.current = null;
      }
      try { unsubscribeLive(cameraId); } catch (_) {}
      setState('stopped');
    },
    restart: async () => {
      try { unsubscribeLive(cameraId); } catch (_) {}
      if (playerRef.current) {
        playerRef.current.stop();
        playerRef.current = null;
      }
      if (detachRef.current) {
        detachRef.current();
        detachRef.current = null;
      }
      await initialize();
    },
    getStats: () => playerRef.current?.getStats() || null
  }), [cameraId, unsubscribeLive]);

  const handleState = useCallback((s) => {
    setState(s);
    onState?.(s);
  }, [onState]);

  const handleError = useCallback((err) => {
    console.error('[LiveVideoPlayer] error:', err);
    setErrorMsg(err?.message || 'Streaming error');
    setState('error');
    onError?.(err);
  }, [onError]);

  const handleFps = useCallback((fps) => {
    onFps?.(fps);
  }, [onFps]);

  const initialize = useCallback(async () => {
    if (!supported) {
      handleState('unsupported');
      return;
    }
    if (!videoRef.current || !socket) return;

    handleState('starting');

    const player = new WebCodecsPlayer(videoRef.current, {
      bitrate,
      framerate,
      onFps: handleFps,
      onError: handleError,
      onState: handleState
    });

    // Notify first frame is loaded once encoder produces output (via state change)
    const onFirstState = (s) => {
      if (s === 'streaming') {
        onLoaded?.();
      }
    };
    player.onState = (s) => {
      handleState(s);
      onFirstState(s);
    };

    const subId = Math.random().toString(36).substring(2, 9);
    
    const init = async () => {
      try {
        // Default dimensions — encoder will adjust on first frame
        await player.start(1280, 720);
        playerRef.current = player;
  
        // Listen for live frames (binary JPEG via Socket.IO)
        detachRef.current = attachLiveFrameSource(socket, cameraId, player);
  
        // Tell the server to start broadcasting frames to this socket
        subscribeLive(cameraId, subId);
      } catch (e) {
        handleError(e);
      }
    };
    init();
    
    return subId;
  }, [cameraId, socket, supported, bitrate, framerate, handleFps, handleError, handleState, onLoaded, subscribeLive]);

  // Lifecycle: start on mount, stop on unmount
  useEffect(() => {
    if (!cameraId || !socket || !supported) return undefined;

    let subId = null;
    initialize().then(id => { subId = id; });

    return () => {
      if (playerRef.current) {
        try { playerRef.current.stop(); } catch (_) {}
        playerRef.current = null;
      }
      if (detachRef.current) {
        try { detachRef.current(); } catch (_) {}
        detachRef.current = null;
      }
      if (subId) {
        try { unsubscribeLive(cameraId, subId); } catch (_) {}
      } else {
        try { unsubscribeLive(cameraId); } catch (_) {}
      }
      setState('stopped');
    };
  }, [cameraId, socket, supported, bitrate, framerate]);

  if (!supported) {
    return fallback || (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 text-slate-400">
        <CameraOff className="w-12 h-12 mb-3" />
        <p className="text-sm">WebCodecs not supported in this browser</p>
        <p className="text-xs text-slate-500 mt-1">Use Chrome 94+ or Edge 94+</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <video
        ref={videoRef}
        className={className}
        style={style}
        autoPlay
        playsInline
        muted
      />

      {/* Initial snapshot while first frame is being encoded */}
      {initialSnapshot && state !== 'streaming' && state !== 'error' && (
        <img
          src={initialSnapshot}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={style}
        />
      )}

      {/* Loading indicator */}
      {(state === 'starting' || state === 'idle') && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
          <div className="flex flex-col items-center">
            <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
            <p className="text-xs text-slate-300 mt-2 font-mono">Encoding H.264…</p>
          </div>
        </div>
      )}

      {/* Error indicator */}
      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-900/20 pointer-events-none">
          <CameraOff className="w-8 h-8 text-red-400 mb-2" />
          <p className="text-xs text-red-300 font-mono">{errorMsg}</p>
        </div>
      )}
    </div>
  );
});

export default LiveVideoPlayer;
