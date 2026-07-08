import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import Navbar from '../components/Navbar';
import VideoStage from '../components/LiveView/VideoStage';
import Toolbar from '../components/LiveView/Toolbar';
import FilterPanel from '../components/LiveView/FilterPanel';
import PhotoGallery from '../components/LiveView/PhotoGallery';
import KeyboardShortcuts from '../components/LiveView/KeyboardShortcuts';
import { useVideoTransform } from '../hooks/useVideoTransform';
import { useVideoFilters } from '../hooks/useVideoFilters';
import { usePhotoCapture, FlashOverlay, ShutterFrame, PhotoCounter } from '../components/LiveView/PhotoCapture';
import { useWebRTCStream } from '../hooks/useWebRTCStream';
import { useAIAutoZoom, useRecentPhotos } from '../hooks/useAIAutoZoom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Camera, CameraOff, AlertTriangle, Shield,
  Maximize, Minimize, Volume2, VolumeX, Bell,
  Cpu, Activity, MapPin, Eye, Wifi, Smartphone, Scan, Globe
} from 'lucide-react';
import toast from 'react-hot-toast';
import AlertConfirmation from '../components/AlertConfirmation';

const API_BASE = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

export default function CameraView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { api } = useAuth();
  const { socket, subscribeToCamera, unsubscribeFromCamera, startDetection, stopDetection, subscribeLive, unsubscribeLive } = useSocket();

  const [camera, setCamera] = useState(null);
  const [detections, setDetections] = useState([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [streamActive, setStreamActive] = useState(false);
  const [fps, setFps] = useState(0);
  const [alertLevel, setAlertLevel] = useState('none');
  const [recentAlerts, setRecentAlerts] = useState([]);
  const [cameraSource, setCameraSource] = useState('webcam');
  const [streamError, setStreamError] = useState(false);
  const [streamUrl, setStreamUrl] = useState(null);
  const [proxyUrl, setProxyUrl] = useState(null);
  const [colabStreamUrl, setColabStreamUrl] = useState(null);
  const [webrtcSignalingUrl, setWebrtcSignalingUrl] = useState(null);
  const [isLoopbackEnabled, setIsLoopbackEnabled] = useState(false);
  const [pendingAlert, setPendingAlert] = useState(null);
  // Snapshot refresh: forces fallback to canvas
  const [snapshotKey, setSnapshotKey] = useState(0);
  // Live View Pro state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aiZoomEnabled, setAiZoomEnabled] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [shutterShow, setShutterShow] = useState(false);
  const [captureUploading, setCaptureUploading] = useState(false);
  const [sendingManualAlert, setSendingManualAlert] = useState(false);
  const [showManualAlertConfirm, setShowManualAlertConfirm] = useState(false);
  const [showAnnotatedView, setShowAnnotatedView] = useState(false);
  const [hasAnnotatedFrame, setHasAnnotatedFrame] = useState(false);
  
  // Start WebRTC automatically when camera is active
  useEffect(() => {
    if (streamActive && !colabStreamUrl && !isLoopbackEnabled) {
      setIsLoopbackEnabled(true);
    }
  }, [streamActive, colabStreamUrl, isLoopbackEnabled]);

  const imgRef = useRef(null);
  const annotatedImgRef = useRef(null);
  const detectionCanvasRef = useRef(null);
  const predictionHistoryRef = useRef(new Map());
  // Smooth tracking refs
  const targetDetsRef = useRef([]);
  const currentDetsRef = useRef([]);
  const [videoRect, setVideoRect] = useState({ left: 0, top: 0, width: '100%', height: '100%' });

  // ============ WebRTC LOOPBACK (Professional Zero-Lag, Zero Tunnel) ============
  const { videoRef: webrtcVideoRef, connected: webrtcConnected, error: webrtcError, fps: webrtcFps, connectLoopback, cleanup: cleanupLoopback } = useWebRTCStream();
  const isWebRTC = webrtcConnected;
  const loopbackCanvasRef = useRef(null);

  // Capture native video and send to Loopback WebRTC
  useEffect(() => {
    let animationFrameId;
    let started = false;
    
    if (isLoopbackEnabled && imgRef.current) {
      if (!loopbackCanvasRef.current) {
        loopbackCanvasRef.current = document.createElement('canvas');
      }
      const canvas = loopbackCanvasRef.current;
      const ctx = canvas.getContext('2d');
      
      const drawFrame = () => {
        if (imgRef.current && imgRef.current.naturalWidth > 0) {
          const el = imgRef.current;
          const w = el.naturalWidth || 640;
          const h = el.naturalHeight || 480;
          
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          
          try {
            ctx.drawImage(el, 0, 0, w, h);
            // Test if canvas is tainted (CORS issue)
            if (!started && canvas.width > 0) {
              try {
                canvas.toDataURL('image/jpeg', 0.5);
                started = true;
                console.log('[WebRTC Loopback] Canvas capture OK, starting stream...');
                const stream = canvas.captureStream(30);
                connectLoopback(stream);
              } catch(e) {
                console.error('[WebRTC Loopback] Canvas tainted (CORS)!', e);
              }
            }
          } catch(e) {
            // Might fail if image not loaded yet
          }
        }
        animationFrameId = requestAnimationFrame(drawFrame);
      };
      drawFrame();
    } else {
      cleanupLoopback();
    }
    
    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [isLoopbackEnabled, connectLoopback, cleanupLoopback]);

  // Update videoRect whenever window resizes or frame loads to perfectly align DOM boxes
  useEffect(() => {
    const updateRect = () => {
      const el = imgRef.current;
      if (!el) return;
      const viewW = el.clientWidth || el.offsetWidth;
      const viewH = el.clientHeight || el.offsetHeight;
      if (!viewW || !viewH) return;
      
      const natW = el.naturalWidth || el.videoWidth || 1280;
      const natH = el.naturalHeight || el.videoHeight || 720;
      
      const viewRatio = viewW / viewH;
      const natRatio = natW / natH;
      
      let renderW = viewW;
      let renderH = viewH;
      let offsetX = 0;
      let offsetY = 0;

      if (natRatio > viewRatio) {
        // Image is wider than container, black bars on top/bottom
        renderH = viewW / natRatio;
        offsetY = (viewH - renderH) / 2;
      } else {
        // Image is taller than container, black bars on left/right
        renderW = viewH * natRatio;
        offsetX = (viewW - renderW) / 2;
      }
      
      setVideoRect({ left: offsetX, top: offsetY, width: renderW, height: renderH });
    };

    window.addEventListener('resize', updateRect);
    const interval = setInterval(updateRect, 1000); // Polling for stream start
    return () => { window.removeEventListener('resize', updateRect); clearInterval(interval); };
  }, [streamActive, streamUrl, snapshotKey]);
  
  // ============ PURE HTTP SEQUENTIAL FRAME FETCH (Zero Buffer, Zero WebSocket) ============
  // Instead of <img src=MJPEG> (which browsers buffer 3-5 seconds), we fetch individual 
  // JPEG frames via HTTP GET in a tight JS loop. Each frame is displayed instantly.
  const token = localStorage.getItem('token') || '';

  // Camera MJPEG — always available for canvas capture (WebRTC loopback needs it)
  const nativeMjpegUrl = camera 
    ? `${API_BASE}/api/cameras/${id}/proxy-stream?t=${snapshotKey}&token=${encodeURIComponent(token)}` 
    : '';

  // Colab frames are now received via Socket.IO (see COLAB WEBSOCKET PUSH useEffect above)
  // The old HTTP polling loop has been replaced by push-based Socket.IO events

  // For non-Colab cameras, set stream active when camera is available
  useEffect(() => {
    if (!colabStreamUrl && camera) {
      setStreamActive(true);
      setStreamError(false);
    } else if (!colabStreamUrl && !camera) {
      setStreamActive(false);
    }
  }, [camera, colabStreamUrl]);

  const detectionTimerRef = useRef(null);
  const lastFrameTsRef = useRef(0);

  const transform = useVideoTransform({ enableKeyboard: false });
  const { filters, setFilter, applyPreset, reset: resetFilters, activePreset, isModified, cssFilter, svgFilter } = useVideoFilters();
  const { capturePhoto, flash, count: capturedCount } = usePhotoCapture(imgRef);
  const { onDetections: feedAutoZoom, trackingActive, trackedLabel } = useAIAutoZoom({
    containerRef: transform.containerRef,
    videoRef: imgRef,
    enabled: aiZoomEnabled
  });
  const { photos, refresh: refreshPhotos } = useRecentPhotos(API_BASE);
  const previewUrl = `${API_BASE}/api/cameras/${id}/preview?t=${snapshotKey}&token=${localStorage.getItem('token') || ''}`;

  // ============ WebRTC CONNECTION MANAGER ============
  // Listens for ntfy.sh notifications from Colab with the WebRTC signaling URL
  // Also monitors WebRTC connection state
  useEffect(() => {
    if (isWebRTC) {
      setStreamActive(true);
      setStreamError(false);
      setColabStreamUrl('webrtc-mode');
    }
  }, [isWebRTC]);

  // Update FPS from WebRTC stats
  useEffect(() => {
    if (webrtcFps > 0) setFps(webrtcFps);
  }, [webrtcFps]);

  // Poll for WebRTC signaling URL from ntfy.sh (Colab publishes it)
  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;
    
    const pollNtfy = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('https://ntfy.sh/sentinelai_firas_webrtc/json?poll=1&since=30s', {
          signal: controller.signal
        });
        clearTimeout(timeout);
        const text = await res.text();
        const lines = text.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const msg = JSON.parse(lines[i]);
            if (msg.message && msg.message.startsWith('https://')) {
              const url = msg.message.trim();
              if (url !== webrtcSignalingUrl) {
                console.log('[WebRTC] New signaling URL from Colab:', url);
                setWebrtcSignalingUrl(url);
              }
              break;
            }
          } catch (e) {}
        }
      } catch (e) {
        // Silently retry
      }
      if (!cancelled) {
        pollTimer = setTimeout(pollNtfy, 10000);
      }
    };
    
    pollNtfy();
    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [webrtcSignalingUrl]);

  // ============ COLAB SOCKET.IO (V16 Push-based) ============
  useEffect(() => {
    if (!socket) return;

    const onColabFrame = (data) => {
      if (!data || !data.frame) return;
      
      if (imgRef.current) {
        imgRef.current.src = `data:image/jpeg;base64,${data.frame}`;
        imgRef.current.style.display = 'block';
      }
      
      if (!streamActive) {
        setStreamActive(true);
        setStreamError(false);
      }
      
      if (data.fps) setFps(data.fps);
      
      if (data.detections && data.detections.length > 0) {
        setDetections(data.detections);
        const hasCritical = data.detections.some(d => d.severity === 'critical');
        const hasWarning = data.detections.some(d => d.severity === 'warning');
        if (hasCritical) setAlertLevel('critical');
        else if (hasWarning) setAlertLevel('medium');
        else setAlertLevel('low');
      } else if (data.detections) {
        setDetections([]);
        setAlertLevel('none');
      }
    };

    const onColabStatus = (status) => {
      if (status.connected) {
        setColabStreamUrl(prev => prev || 'push-mode');
      } else {
        setColabStreamUrl(null);
      }
    };

    socket.on('colab-annotated-frame', onColabFrame);
    socket.on('colab-status', onColabStatus);
    socket.emit('subscribe-colab');

    return () => {
      socket.off('colab-annotated-frame', onColabFrame);
      socket.off('colab-status', onColabStatus);
      socket.emit('unsubscribe-colab');
    };
  }, [socket, streamActive, isWebRTC]);

  // ============ FETCH CAMERA + STREAM URL ============
  useEffect(() => {
    const fetchCamera = async () => {
      try {
        const response = await api.get(`/cameras/${id}`);
        if (response.status !== 200 || !response.data) {
          toast.error('Camera not found');
          navigate('/', { replace: true });
          return;
        }
        const cam = response.data;
        setCamera(cam);

        if (cam.protocol === 'rtsp' || cam.protocol === 'rtmp') {
          try {
            await api.post(`/cameras/${cam.id}/hls/start`);
            setStreamUrl(`${API_BASE}/hls/${cam.id}/index.m3u8`);
            setCameraSource('ip-camera-hls');
            setStreamActive(true);
            return;
          } catch (e) { console.warn('HLS proxy failed', e); }
        }

        // Use the streamUrl that the GET /:id endpoint already resolved
        if (cam.streamUrl) {
          const isExternal = !(cam.url && cam.url.startsWith('usb'));
          // ZERO-LATENCY: Always prefer direct camera URL (streamUrl) over Node.js proxy
          // The proxy adds buffering + JS overhead. Direct <img> MJPEG is hardware-decoded.
          const primaryUrl = cam.streamUrl;
          setStreamUrl(primaryUrl);
          setProxyUrl(cam.proxyUrl);
          setCameraSource(isExternal ? 'ip-camera' : 'usb');
          setStreamActive(true);
        } else {
          // Fallback: explicit stream-url call (should rarely happen now)
          const urlRes = await api.get(`/cameras/${id}/stream-url`);
          if (urlRes.data && urlRes.data.url) {
            const isExternal = !urlRes.data.source?.startsWith('usb');
            const primaryUrl = (isExternal && urlRes.data.proxyUrl) ? urlRes.data.proxyUrl : urlRes.data.url;
            setStreamUrl(primaryUrl);
            setProxyUrl(urlRes.data.proxyUrl);
            setCameraSource(isExternal ? 'ip-camera' : 'usb');
            setStreamActive(true);
          }
        }

        if (cam.detectionEnabled !== false) {
          if (detectionTimerRef.current) clearTimeout(detectionTimerRef.current);
          detectionTimerRef.current = setTimeout(() => {
            setIsDetecting(true);
            startDetection(id);
          }, 2000);
        }
      } catch (error) {
        console.error('[CameraView] fetch error:', error);
        if (error.response?.status === 404 || error.response?.status === 401) {
          toast.error(error.response?.status === 404 ? 'Camera not found' : 'Please log in again');
          setTimeout(() => navigate('/', { replace: true }), 1500);
        } else {
          toast.error('Cannot load camera');
        }
      }
    };
    fetchCamera();
    return () => {
      if (detectionTimerRef.current) clearTimeout(detectionTimerRef.current);
      // Stop detection when leaving the camera view so the IP Webcam is not hammered
      // for cameras no one is watching (IP Webcam = single-threaded, max 2-3 conns).
      stopDetection(id);
      setIsDetecting(false);
    };
  }, [id, api, navigate, startDetection, stopDetection]);



  const startFps = () => {
    frameCountRef.current = 0;
    lastTimeRef.current = Date.now();
    fpsIntervalRef.current = setInterval(() => {
      frameCountRef.current++;
      const now = Date.now();
      if (now - lastTimeRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }
    }, 1000 / 30);
  };
  const stopFps = () => { if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current); setFps(0); };

  // ============ SOCKET ============
  useEffect(() => {
    subscribeToCamera(id);
    return () => unsubscribeFromCamera(id);
  }, [id, subscribeToCamera, unsubscribeFromCamera]);



  useEffect(() => {
    if (!socket) return;
    const onDetections = (data) => {
      if (data.cameraId === id) {
        const now = Date.now();
        const predictedDetections = (data.detections || []).map(d => {
          if (!d.trackId) return d;
          const hist = predictionHistoryRef.current.get(d.trackId);
          let predicted = { ...d, boundingBox: { ...d.boundingBox } };
          if (hist) {
            const dt = now - hist.timestamp;
            if (dt > 0 && dt < 2000) {
              const vx = (d.boundingBox.x - hist.x) / dt;
              const vy = (d.boundingBox.y - hist.y) / dt;
              // Extrapolate forward by roughly the AI processing delay (700ms)
              predicted.boundingBox.x += vx * 700 * 0.7;
              predicted.boundingBox.y += vy * 700 * 0.7;
              // Bounds checking
              predicted.boundingBox.x = Math.max(0, Math.min(1 - predicted.boundingBox.width, predicted.boundingBox.x));
              predicted.boundingBox.y = Math.max(0, Math.min(1 - predicted.boundingBox.height, predicted.boundingBox.y));
            }
          }
          predictionHistoryRef.current.set(d.trackId, {
            x: d.boundingBox.x,
            y: d.boundingBox.y,
            timestamp: now
          });
          return predicted;
        });
        
        setDetections(predictedDetections);
        
        const hasCritical = predictedDetections.some(d => d.type === 'intrusion' || d.severity === 'critical');
        const hasWarning = predictedDetections.some(d => d.severity === 'warning' || d.type === 'loitering');
        if (hasCritical) setAlertLevel('critical');
        else if (hasWarning) setAlertLevel('medium');
        else if (predictedDetections.length > 0) setAlertLevel('low');
        if (aiZoomEnabled) {
          const flat = predictedDetections.map(d => ({
            label: d.type, x: d.boundingBox?.x ?? 0, y: d.boundingBox?.y ?? 0,
            width: d.boundingBox?.width ?? 0, height: d.boundingBox?.height ?? 0
          }));
          feedAutoZoom(flat);
        }
      }
    };
    const onAlert = (alert) => {
      if (alert.cameraId === id) {
        setRecentAlerts(prev => [alert, ...prev].slice(0, 20));
        if (alert.details?.requiresHuman) {
          setPendingAlert(alert);
        }
      }
    };
    const onAnnotatedFrame = (data) => {
      if (data.cameraId === id && data.frame) {
        if (annotatedImgRef.current) {
          annotatedImgRef.current.src = `data:image/jpeg;base64,${data.frame}`;
          setHasAnnotatedFrame(true);
        }
      }
    };
    socket.on('detections', onDetections);
    socket.on('alert', onAlert);
    socket.on('annotated-frame', onAnnotatedFrame);
    return () => { socket.off('detections', onDetections); socket.off('alert', onAlert); socket.off('annotated-frame', onAnnotatedFrame); };
  }, [socket, id, aiZoomEnabled, feedAutoZoom]);

  // ============ DETECTION CONTROLS ============
  const handleStartDetection = () => { setIsDetecting(true); startDetection(id); toast.success('AI detection activated'); };
  const handleStopDetection = () => { 
    setIsDetecting(false); 
    stopDetection(id); 
    setDetections([]); 
    targetDetsRef.current = [];
    currentDetsRef.current = [];
    setAlertLevel('none'); 
    setHasAnnotatedFrame(false);
    setShowAnnotatedView(false);
    toast.success('AI detection deactivated'); 
  };

  // ============ PHOTO CAPTURE ============
  const handleCapture = useCallback(async () => {
    if (captureUploading) return;
    setShutterShow(true);
    setTimeout(() => setShutterShow(false), 500);
    const token = localStorage.getItem('token') || '';

    // Strategy:
    // With native MJPEG <img>, we cannot capture from the element directly due to CORS limitations.
    // Instead, we hit the server endpoint to fetch a guaranteed fresh frame from the stream proxy.
    let result = null;

    if (!result) {
      try {
        result = await capturePhoto({
          preferServer: true,
          apiBase: API_BASE,
          cameraId: id,
          token
        });
      } catch (err) {
        console.error('[CameraView] capturePhoto failed:', err);
      }
    }

    if (!result || !result.blob) {
      const reason = (typeof result === 'object' && result?.lastError) || 'Could not capture photo';
      console.error('[CameraView] capture failed:', reason);
      toast.error(typeof reason === 'string' ? reason : 'Could not capture photo');
      return;
    }
    setCaptureUploading(true);
    try {
      await api.post('/photos', {
        cameraId: id, cameraName: camera?.name,
        base64: result.dataUrl, mime: 'image/jpeg',
        width: result.width, height: result.height,
        context: {
          source: result.source || 'unknown',
          activePreset, filtersApplied: isModified,
          zoom: transform.zoom, rotation: transform.rotation,
          detections: detections.map(d => ({ type: d.type, confidence: d.confidence })),
          threatLevel: alertLevel
        }
      });
      toast.success(`Photo saved! (${(result.blob.size / 1024).toFixed(0)} KB)`);
      refreshPhotos();
    } catch (err) { toast.error('Failed to upload photo'); console.error(err); }
    finally { setCaptureUploading(false); }
  }, [captureUploading, capturePhoto, id, camera, activePreset, isModified, transform.zoom, transform.rotation, detections, alertLevel, api, refreshPhotos]);

  // ============ RETRY on error ============
  const handleRetry = () => {
    setStreamError(false);
    if (proxyUrl) {
      setStreamUrl(`${proxyUrl}${(proxyUrl).includes('?') ? '&' : '?'}t=${Date.now()}`);
    } else {
      // Re-fetch the stream url
      api.get(`/cameras/${id}/stream-url`).then(urlRes => {
        if (urlRes.data && urlRes.data.url) {
          setStreamUrl(`${urlRes.data.url}${urlRes.data.url.includes('?') ? '&' : '?'}t=${Date.now()}`);
          setProxyUrl(urlRes.data.proxyUrl);
        }
      });
    }
  };

  // ============ KEYBOARD SHORTCUTS ============
  useEffect(() => {
    const handler = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      switch (e.key) {
        case '+': case '=': e.preventDefault(); transform.zoomIn(); break;
        case '-': case '_': e.preventDefault(); transform.zoomOut(); break;
        case '0': e.preventDefault(); transform.reset(); resetFilters(); break;
        case 'r': case 'R': e.preventDefault(); transform.rotateRight(); break;
        case 'l': case 'L': e.preventDefault(); transform.rotateLeft(); break;
        case 'h': case 'H': e.preventDefault(); transform.toggleFlipH(); break;
        case 'v': case 'V': e.preventDefault(); transform.toggleFlipV(); break;
        case 'a': case 'A': e.preventDefault(); transform.cycleAspect(); break;
        case 'f': case 'F': e.preventDefault(); transform.toggleFullscreen(); break;
        case ' ': e.preventDefault(); break;
        case 'p': case 'P': e.preventDefault(); handleCapture(); break;
        case 'g': case 'G': e.preventDefault(); setGalleryOpen(true); break;
        case 'i': case 'I': e.preventDefault(); setFiltersOpen(f => !f); break;
        case 'z': case 'Z': e.preventDefault(); setAiZoomEnabled(z => !z); break;
        case 'k': case 'K': e.preventDefault(); transform.toggleLock(); break;
        case '?': e.preventDefault(); setShortcutsOpen(true); break;
        case 'Escape':
          if (shortcutsOpen) setShortcutsOpen(false);
          else if (filtersOpen) setFiltersOpen(false);
          else if (galleryOpen) setGalleryOpen(false);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [transform, resetFilters, handleCapture, filtersOpen, galleryOpen, shortcutsOpen]);

  const alertColors = {
    none: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
    low: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    medium: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
    high: 'bg-orange-500/10 text-orange-400 border border-orange-500/20',
    critical: 'bg-red-500/10 text-red-400 border border-red-500/20 animate-pulse'
  };

  const handleConfirmAlert = (alert) => {
    setPendingAlert(null);
    toast.error('POLICE APPELÉE ! Action confirmée.', { duration: 5000, icon: '🚨' });
    // This would send a REST call to the backend to confirm the alert and notify authorities
  };

  const handleDismissAlert = (alert) => {
    setPendingAlert(null);
    toast.success('Alerte ignorée.');
  };

  // ============ MANUAL ALERT ============
  const handleManualAlert = useCallback(async () => {
    if (sendingManualAlert) return;
    setSendingManualAlert(true);
    setShowManualAlertConfirm(false);
    try {
      // Try to capture a frame from the current view to attach to the alert
      let frameBase64 = null;
      try {
        const canvas = document.createElement('canvas');
        const el = imgRef.current;
        if (el) {
          canvas.width = el.naturalWidth || el.videoWidth || 1280;
          canvas.height = el.naturalHeight || el.videoHeight || 720;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          frameBase64 = canvas.toDataURL('image/jpeg', 0.85);
        }
      } catch (e) { /* ignore capture errors, backend will try its own capture */ }

      await api.post(`/cameras/${id}/manual-alert`, {
        description: 'Manual alert triggered by operator during live monitoring',
        frameBase64: frameBase64 || undefined
      });
      toast.success('🚨 Manual alert sent! Check your Telegram & Email.', { duration: 5000 });
    } catch (err) {
      console.error('[ManualAlert]', err);
      toast.error('Failed to send manual alert');
    } finally {
      setSendingManualAlert(false);
    }
  }, [sendingManualAlert, api, id]);

  return (
    <div className="min-h-screen bg-[#030712] text-slate-300 font-sans selection:bg-emerald-500/30">
      <Navbar />
      
      {/* Human Confirmation Modal for AI Alerts */}
      <AnimatePresence>
        {pendingAlert && (
          <AlertConfirmation 
            alert={pendingAlert} 
            onConfirm={handleConfirmAlert} 
            onDismiss={handleDismissAlert} 
          />
        )}
      </AnimatePresence>

      {/* Manual Alert Confirmation Modal */}
      <AnimatePresence>
        {showManualAlertConfirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }} className="bg-slate-900 border border-red-500/50 rounded-2xl p-6 max-w-md w-full shadow-2xl shadow-red-900/20">
              <div className="flex items-center space-x-4 mb-4">
                <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center border border-red-500/30">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Trigger Manual Alert?</h2>
                  <p className="text-sm text-slate-400">This will instantly notify all channels.</p>
                </div>
              </div>
              <p className="text-slate-300 mb-6 text-sm">
                Are you sure you want to trigger a manual security alert? This will capture the current video frame and send an emergency notification via Telegram, Email, and Push Notifications.
              </p>
              <div className="flex space-x-3">
                <button onClick={() => setShowManualAlertConfirm(false)} className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-semibold transition-colors">
                  Cancel
                </button>
                <button onClick={handleManualAlert} disabled={sendingManualAlert} className="flex-1 flex items-center justify-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition-colors disabled:opacity-50">
                  {sendingManualAlert ? 'Sending...' : 'Yes, Trigger Alert'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-4">
            <motion.button whileHover={{ scale: 1.1, x: -3 }} whileTap={{ scale: 0.9 }} onClick={() => navigate('/')} className="p-2 hover:bg-slate-800 rounded-xl text-slate-400 hover:text-white border border-slate-800">
              <ArrowLeft className="w-5 h-5" />
            </motion.button>
            <div>
              <h1 className="text-2xl font-black text-white">{camera?.name || 'Loading...'}</h1>
              <div className="flex items-center text-slate-400 text-sm mt-0.5">
                <MapPin className="w-3.5 h-3.5 mr-1" />{camera?.location}
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <div className={`flex items-center px-3 py-1.5 rounded-full text-sm font-bold ${alertColors[alertLevel]}`}>
              <Shield className="w-4 h-4 mr-1.5" />
              {alertLevel === 'none' ? 'All Clear' : alertLevel.toUpperCase()}
            </div>
            <div className="flex items-center px-3 py-1.5 bg-slate-800/80 rounded-full text-sm text-slate-300 font-mono border border-slate-700/50">
              <Activity className="w-4 h-4 mr-1.5 text-indigo-400" />
              {fps} FPS
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="gradient-border overflow-hidden">
              <div className="relative aspect-video bg-black rounded-t-xl overflow-hidden">
                <VideoStage
                  ref={transform.containerRef}
                  transform={transform.transform}
                  cssFilter={cssFilter}
                  svgFilter={svgFilter}
                  objectFit={transform.objectFit}
                  isDragging={transform.isDragging}
                  isLocked={transform.isLocked}
                  onMouseDown={(e) => { transform.startDrag(e); setShortcutsOpen(false); }}
                  onMouseMove={transform.onDrag}
                  onMouseUp={transform.endDrag}
                  onMouseLeave={transform.endDrag}
                >
                  {/* VIDEO — WebRTC loopback or native MJPEG */}
                  {isWebRTC ? (
                    <video
                      ref={webrtcVideoRef}
                      autoPlay playsInline muted
                      className="w-full h-full object-contain"
                      style={{ objectFit: transform.objectFit }}
                    />
                  ) : cameraSource === 'ip-camera-hls' && streamUrl ? (
                    <video
                      ref={imgRef}
                      autoPlay playsInline muted={isMuted}
                      className="w-full h-full"
                      style={{ objectFit: transform.objectFit }}
                    >
                      <source src={streamUrl} type="application/vnd.apple.mpegurl" />
                    </video>
                  ) : (
                    <img
                      ref={imgRef}
                      src={nativeMjpegUrl || undefined}
                      alt="Live Camera Feed"
                      className={`w-full h-full object-contain ${isWebRTC ? 'opacity-[0.001] absolute pointer-events-none' : ''}`}
                      style={{ objectFit: transform.objectFit }}
                      onLoad={() => {
                        if (!streamActive) setStreamActive(true);
                      }}
                      onError={() => {
                        if (!colabStreamUrl) setStreamError(true);
                      }}
                    />
                  )}
                    
                  {/* WebRTC Connection Badge */}
                  {isWebRTC && (
                    <div className="absolute top-4 left-4 z-20 flex items-center px-3 py-1.5 bg-emerald-600 rounded-lg text-white text-sm font-bold shadow-lg shadow-emerald-500/30">
                      <Wifi className="w-4 h-4 mr-1.5" /> WebRTC {webrtcFps > 0 ? `${webrtcFps} FPS` : ''}
                    </div>
                  )}

                  {/* WebRTC Error/Connecting indicator */}
                  {isLoopbackEnabled && !webrtcConnected && (
                    <div className="absolute inset-0 flex items-center justify-center z-15">
                      <div className="text-center">
                        <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full mx-auto mb-3" />
                        <p className="text-white/80 text-sm">Connexion WebRTC Colab P2P en cours...</p>
                        {webrtcError && <p className="text-red-400 text-xs mt-1">{webrtcError}</p>}
                      </div>
                    </div>
                  )}

                  {/* AI Annotated View — fallback for non-WebRTC */}
                  <img 
                    ref={annotatedImgRef}
                    className="hidden"
                    style={{ 
                      objectFit: transform.objectFit,
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      zIndex: 5
                    }}
                    alt="AI Annotated View"
                  />
                </VideoStage>

                {/* DOM-BASED HARDWARE ACCELERATED DETECTIONS */}
                {isDetecting && !colabStreamUrl && (
                  <div 
                    className="absolute z-10 pointer-events-none"
                    style={{
                      left: videoRect.left, 
                      top: videoRect.top, 
                      width: videoRect.width, 
                      height: videoRect.height,
                      transform: `scale(${transform.zoom * (transform.flipH ? -1 : 1)}, ${transform.zoom * (transform.flipV ? -1 : 1)}) rotate(${transform.rotation}deg)`, 
                      transformOrigin: 'center'
                    }}
                  >
                    {detections.map((det, idx) => {
                      if (!det.boundingBox) return null;
                      const b = det.boundingBox;
                      const isViolence = det.type === 'violence';
                      const isWeapon = det.type === 'weapon' || det.type === 'weapon_detected';
                      const isTheft = det.type === 'theft';
                      const colorClass = isWeapon ? 'border-red-500 text-red-500' : isViolence ? 'border-purple-500 text-purple-500' : isTheft ? 'border-amber-500 text-amber-500' : 'border-emerald-500 text-emerald-500';
                      const bgClass = isWeapon ? 'bg-red-500' : isViolence ? 'bg-purple-500' : isTheft ? 'bg-amber-500' : 'bg-emerald-500';
                      
                      let labelType = det.type === 'person' ? 'Person' : det.type.replace(/_/g, ' ');
                      labelType = labelType.charAt(0).toUpperCase() + labelType.slice(1);
                      if (det.behavior && !['Normal', 'Unknown', 'Warming'].includes(det.behavior)) {
                        labelType += ` | ${det.behavior}`;
                      }
                      const labelStr = `${labelType} ${(det.confidence * 100).toFixed(0)}%`;

                      return (
                        <div 
                          key={det.trackId ? `track-${det.trackId}` : `det-${idx}`}
                          className="absolute pointer-events-none"
                          style={{
                            left: `${b.x * 100}%`,
                            top: `${b.y * 100}%`,
                            width: `${b.width * 100}%`,
                            height: `${b.height * 100}%`,
                            transition: 'all 0.5s linear' // Predictive smooth tracking (0.5s)
                          }}
                        >
                          {/* BoxCornerAnnotator Corners */}
                          <div className={`absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 ${colorClass}`} />
                          <div className={`absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 ${colorClass}`} />
                          <div className={`absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 ${colorClass}`} />
                          <div className={`absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 ${colorClass}`} />
                          
                          {/* Label */}
                          <div className={`absolute -top-7 left-0 px-2 py-1 text-xs font-bold text-black rounded ${bgClass} whitespace-nowrap tracking-wide`}>
                            {labelStr}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <PhotoCounter count={capturedCount} onOpenGallery={() => setGalleryOpen(true)} />
                <FlashOverlay show={flash} />
                <ShutterFrame show={shutterShow} />

                {!streamActive && !streamUrl && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#030712]/95">
                    <motion.div animate={{ y: [0, -10, 0] }} transition={{ duration: 3, repeat: Infinity }} className="w-24 h-24 rounded-2xl bg-slate-800/80 flex items-center justify-center mb-6 border border-slate-700/50">
                      <CameraOff className="w-12 h-12 text-slate-600" />
                    </motion.div>
                    <p className="text-xl font-bold text-white mb-2">No Camera Connected</p>
                    <p className="text-sm text-slate-400 mb-8">Connect a camera from the dashboard</p>
                  </div>
                )}

                {streamUrl && streamError && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#030712]/95">
                    <AlertTriangle className="w-16 h-16 text-amber-500 mb-4" />
                    <p className="text-xl font-bold text-white mb-2">Stream Connection Error</p>
                    <p className="text-sm text-slate-400 mb-4">Cannot connect to camera stream</p>
                    <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={handleRetry} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm border border-slate-700">Retry</motion.button>
                  </div>
                )}

                {streamActive && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute top-4 left-4 z-20 flex items-center px-3 py-1.5 bg-red-500 rounded-lg text-white text-sm font-bold shadow-lg shadow-red-500/30">
                    <span className="w-2 h-2 bg-white rounded-full animate-pulse mr-2" /> LIVE
                  </motion.div>
                )}
                {colabStreamUrl && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute top-4 right-4 z-20 flex items-center px-3 py-1.5 bg-indigo-600 rounded-lg text-white text-sm font-bold shadow-lg shadow-indigo-500/30">
                    <Cpu className="w-4 h-4 mr-1.5" /> AI ACTIVE
                  </motion.div>
                )}
                {isDetecting && !colabStreamUrl && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute top-4 right-4 z-20 flex items-center px-3 py-1.5 bg-indigo-600 rounded-lg text-white text-sm font-bold shadow-lg shadow-indigo-500/30">
                    <Cpu className="w-4 h-4 mr-1.5" /> AI ACTIVE
                  </motion.div>
                )}
                {showAnnotatedView && isDetecting && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute top-14 right-4 z-20 flex items-center px-3 py-1.5 bg-purple-600 rounded-lg text-white text-sm font-bold shadow-lg shadow-purple-500/30">
                    <Eye className="w-4 h-4 mr-1.5" /> SUPERVISION VIEW
                  </motion.div>
                )}
                {aiZoomEnabled && trackingActive && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="absolute top-4 right-32 z-20 flex items-center px-2.5 py-1 bg-emerald-500/90 rounded-lg text-white text-xs font-bold shadow-lg">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse mr-1.5" />
                    TRACKING {trackedLabel?.toUpperCase()}
                  </motion.div>
                )}
                {detections.length > 0 && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute bottom-20 left-4 z-20 flex items-center px-3 py-1.5 bg-amber-500 rounded-lg text-white text-sm font-bold shadow-lg shadow-amber-500/30">
                    <Eye className="w-4 h-4 mr-1.5" /> {detections.length} DETECTION{detections.length !== 1 ? 'S' : ''}
                  </motion.div>
                )}

                {streamActive && <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-indigo-500 to-transparent opacity-50 z-10" />}

                {streamActive && (
                  <motion.div
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.3, type: 'spring', stiffness: 250 }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-2"
                  >
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={handleCapture} disabled={captureUploading} title="Capture photo (P)" className="p-3 rounded-full bg-white/10 hover:bg-amber-500/80 backdrop-blur-md border-2 border-white/30 shadow-2xl shadow-black/50 transition-all disabled:opacity-50">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                    </motion.button>
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => setGalleryOpen(true)} title="Open gallery (G)" className="p-3 rounded-full bg-white/10 hover:bg-indigo-500/80 backdrop-blur-md border-2 border-white/30 shadow-2xl shadow-black/50 transition-all">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                        <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" />
                      </svg>
                    </motion.button>
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => setFiltersOpen(f => !f)} title="Image filters (I)" className="p-3 rounded-full bg-white/10 hover:bg-purple-500/80 backdrop-blur-md border-2 border-white/30 shadow-2xl shadow-black/50 transition-all">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                        <circle cx="12" cy="12" r="10" /><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" />
                      </svg>
                    </motion.button>
                    <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} onClick={() => setShortcutsOpen(true)} title="Keyboard shortcuts (?)" className="p-3 rounded-full bg-white/10 hover:bg-cyan-500/80 backdrop-blur-md border-2 border-white/30 shadow-2xl shadow-black/50 transition-all">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                        <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
                      </svg>
                    </motion.button>
                  </motion.div>
                )}

                {streamActive && (
                  <Toolbar
                    zoom={transform.zoom} rotation={transform.rotation} flipH={transform.flipH} flipV={transform.flipV}
                    aspect={transform.aspect} isLocked={transform.isLocked} isPlaying={isPlaying}
                    isModified={isModified} activePreset={activePreset} aiEnabled={aiZoomEnabled} filtersOpen={filtersOpen}
                    onZoomIn={transform.zoomIn} onZoomOut={transform.zoomOut} onRotateLeft={transform.rotateLeft}
                    onRotateRight={transform.rotateRight} onFlipH={transform.toggleFlipH} onFlipV={transform.toggleFlipV}
                    onAspect={transform.cycleAspect} onReset={() => { transform.reset(); resetFilters(); }}
                    onLock={transform.toggleLock} onPlayPause={() => {}}
                    onOpenFilters={() => setFiltersOpen(f => !f)} onCapture={handleCapture}
                    onOpenGallery={() => setGalleryOpen(true)} onToggleFullscreen={transform.toggleFullscreen}
                    onToggleAI={() => setAiZoomEnabled(z => !z)} onShowKeyboard={() => setShortcutsOpen(true)}
                  />
                )}

                <FilterPanel
                  open={filtersOpen} onClose={() => setFiltersOpen(false)}
                  filters={filters} setFilter={setFilter} applyPreset={applyPreset}
                  activePreset={activePreset} reset={resetFilters} isModified={isModified}
                />
              </div>

              <div className="p-4 flex items-center justify-between bg-slate-900/50">
                <div className="flex items-center space-x-3">
                  {streamUrl && (
                    <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={handleRetry} className="flex items-center px-5 py-2.5 rounded-xl font-semibold text-sm bg-slate-800 hover:bg-slate-700 text-white border border-slate-700">
                      <Globe className="w-4 h-4 mr-2" /> {cameraSource === 'ip-camera' ? 'IP Camera' : cameraSource === 'usb' ? 'USB Camera' : 'Camera'}
                    </motion.button>
                  )}
                  <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={isDetecting ? handleStopDetection : handleStartDetection} disabled={!streamActive} className={`flex items-center px-5 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed ${isDetecting ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-lg shadow-amber-500/20' : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'}`}>
                    <Scan className="w-4 h-4 mr-2" />
                    {isDetecting ? 'Stop AI' : 'Start AI'}
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setIsLoopbackEnabled(v => !v)}
                    disabled={!streamActive}
                    className={`flex items-center px-5 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                      isLoopbackEnabled
                        ? 'bg-purple-600 hover:bg-purple-700 text-white shadow-lg shadow-purple-500/20'
                        : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'
                    }`}
                  >
                    <Eye className="w-4 h-4 mr-2" />
                    {isLoopbackEnabled ? 'Stop AI Colab (WebRTC)' : 'Start AI Colab (WebRTC)'}
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setShowManualAlertConfirm(true)}
                    disabled={!streamActive || sendingManualAlert}
                    className="flex items-center px-5 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-500/30 border border-red-500/50"
                  >
                    <Bell className="w-4 h-4 mr-2" />
                    {sendingManualAlert ? 'Sending...' : '🚨 Alert'}
                  </motion.button>
                </div>
                <div className="flex items-center space-x-2">
                  <motion.button whileHover={{ scale: 1.1 }} onClick={() => setIsMuted(!isMuted)} className="p-2 hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white">
                    {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                  </motion.button>
                  <motion.button whileHover={{ scale: 1.1 }} onClick={transform.toggleFullscreen} className="p-2 hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white">
                    <Maximize className="w-5 h-5" />
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </div>

          <div className="lg:col-span-1 space-y-4">
            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }} className="glass rounded-2xl p-4 border border-slate-800/50">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center"><Eye className="w-5 h-5 mr-2 text-indigo-400" /> Live Detections</h3>
              {detections.length === 0 ? (
                <div className="text-center py-8"><Scan className="w-12 h-12 text-slate-700 mx-auto mb-2" /><p className="text-sm text-slate-500">No detections</p></div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {detections.map((det, i) => (
                    <motion.div key={i} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className={`p-3 rounded-xl text-sm border ${det.severity === 'critical' ? 'bg-red-500/10 border-red-500/20' : det.severity === 'warning' ? 'bg-amber-500/10 border-amber-500/20' : 'bg-slate-800/50 border-slate-700/50'}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-white capitalize">{det.type.replace(/_/g, ' ')}</span>
                        <span className="text-xs text-slate-400 font-mono">{(det.confidence * 100).toFixed(0)}%</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1 font-mono">{new Date(det.timestamp).toLocaleTimeString()}</div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>

            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }} className="glass rounded-2xl p-4 border border-slate-800/50">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center"><AlertTriangle className="w-5 h-5 mr-2 text-amber-400" /> Recent Alerts</h3>
              {recentAlerts.length === 0 ? (
                <div className="text-center py-8"><Shield className="w-12 h-12 text-slate-700 mx-auto mb-2" /><p className="text-sm text-slate-500">No alerts</p></div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {recentAlerts.map((alert, i) => (
                    <div key={alert.id || i} className={`p-3 rounded-xl text-sm border ${alert.severity === 'critical' ? 'bg-red-500/10 border-red-500/20' : 'bg-amber-500/10 border-amber-500/20'}`}>
                      <div className="font-bold text-white capitalize">{alert.type.replace(/_/g, ' ')}</div>
                      <div className="text-xs text-slate-500 mt-1 font-mono">{new Date(alert.timestamp).toLocaleTimeString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>

            <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 }} className="glass rounded-2xl p-4 border border-slate-800/50">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center"><Camera className="w-5 h-5 mr-2 text-indigo-400" /> Info</h3>
              <div className="space-y-3 text-sm">
                {[
                  { label: 'Status', value: <span className={`flex items-center ${streamActive && !streamError ? 'text-emerald-400' : 'text-red-400'}`}><Wifi className="w-3.5 h-3.5 mr-1" />{streamActive && !streamError ? 'Connected' : 'Disconnected'}</span> },
                  { label: 'Source', value: <span className="text-white capitalize flex items-center">{cameraSource === 'ip-camera' && <Globe className="w-3.5 h-3.5 mr-1 text-indigo-400" />}{cameraSource.replace('-', ' ')}</span> },
                  { label: 'Stream', value: <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${isWebRTC ? 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>{isWebRTC ? 'Loopback WebRTC' : 'MJPEG Direct'}</span> },
                  { label: 'URL', value: <span className="text-white text-xs font-mono truncate max-w-[120px] block" title={streamUrl}>{streamUrl ? `${streamUrl.slice(0, 40)}...` : 'N/A'}</span> },
                  { label: 'Zoom', value: <span className="text-amber-300 font-mono font-bold">{transform.zoom.toFixed(1)}×</span> },
                  { label: 'Filter', value: <span className="text-indigo-300 capitalize">{activePreset}</span> },
                   { label: 'AI Colab', value: <span className={isLoopbackEnabled ? 'text-purple-400 font-bold' : 'text-slate-500'}>{isLoopbackEnabled ? (isWebRTC ? 'WEBRTC CONNECTED' : 'WEBRTC CONNECTING...') : 'OFF'}</span> },
                ].map((item, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-slate-400">{item.label}</span>
                    {item.value}
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </div>
      </main>

      <PhotoGallery
        open={galleryOpen} onClose={() => setGalleryOpen(false)} photos={photos}
        onDelete={async (p) => { try { await api.delete(`/photos/${p.id}`); refreshPhotos(); toast.success('Photo deleted'); } catch (e) { toast.error('Delete failed'); } }}
        onDownload={(p) => { const a = document.createElement('a'); a.href = p.url.startsWith('http') ? p.url : `${API_BASE}${p.url}`; a.download = p.filename || `photo-${p.id}.jpg`; a.click(); }}
      />
      <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
