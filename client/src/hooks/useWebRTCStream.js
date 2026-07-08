import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useWebRTCStream — Professional WebRTC video stream hook
 * 
 * Instead of MJPEG-over-HTTP (which tunnels buffer), this uses WebRTC:
 * - The tunnel (Pinggy/Cloudflare) only carries the tiny SDP signaling (~500 bytes)
 * - Video travels directly via WebRTC UDP (STUN/TURN), bypassing all tunnel buffering
 * - Target latency: 200-500ms instead of 3-10 seconds
 * 
 * @param {string} signalingUrl - The Pinggy/Cloudflare URL (e.g. https://xxx.free.pinggy.net)
 * @returns {{ videoRef, connected, error, fps, reconnect }}
 */
export function useWebRTCStream(signalingUrl) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [fps, setFps] = useState(0);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const fpsCounterRef = useRef({ count: 0, lastTime: Date.now() });

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setConnected(false);
  }, []);

  const connect = useCallback(async (url) => {
    if (!url || !mountedRef.current) return;

    cleanup();
    setError(null);

    try {
      // Normalize URL: strip trailing /video, /offer, etc.
      const baseUrl = url.replace(/\/(video|offer|health)\/?$/, '');
      const offerUrl = `${baseUrl}/offer`;

      console.log('[WebRTC] Creating peer connection...');

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          {
            urls: [
              'turn:openrelay.metered.ca:80',
              'turn:openrelay.metered.ca:443',
              'turn:openrelay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceCandidatePoolSize: 4
      });
      pcRef.current = pc;

      // Add receive-only video transceiver
      pc.addTransceiver('video', { direction: 'recvonly' });

      // Handle incoming video track
      pc.ontrack = (event) => {
        console.log('[WebRTC] Received video track!');
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
          
          // FPS counter on the MediaStream
          const track = event.streams[0].getVideoTracks()[0];
          if (track) {
            const interval = setInterval(() => {
              if (!mountedRef.current || pc.connectionState === 'closed') {
                clearInterval(interval);
                return;
              }
              // Use getStats to measure actual received FPS
              pc.getStats(track).then(stats => {
                stats.forEach(report => {
                  if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    const now = Date.now();
                    const elapsed = (now - fpsCounterRef.current.lastTime) / 1000;
                    if (elapsed > 0 && report.framesDecoded !== undefined) {
                      const newFrames = report.framesDecoded - fpsCounterRef.current.count;
                      if (elapsed > 0.5) {
                        setFps(Math.round(newFrames / elapsed));
                        fpsCounterRef.current = { count: report.framesDecoded, lastTime: now };
                      }
                    }
                  }
                });
              }).catch(() => {});
            }, 2000);
          }

          setConnected(true);
          setError(null);
        }
      };

      // Monitor connection state
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[WebRTC] Connection state: ${state}`);
        
        if (state === 'connected') {
          setConnected(true);
          setError(null);
        } else if (state === 'failed' || state === 'disconnected') {
          setConnected(false);
          // Auto-reconnect after 3 seconds
          if (mountedRef.current) {
            console.log('[WebRTC] Connection lost, reconnecting in 3s...');
            reconnectTimerRef.current = setTimeout(() => {
              if (mountedRef.current) connect(url);
            }, 3000);
          }
        } else if (state === 'closed') {
          setConnected(false);
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE state: ${pc.iceConnectionState}`);
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (collects all candidates including TURN relay)
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timeout = setTimeout(resolve, 5000); // Max 5s for ICE gathering
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            resolve();
          }
        };
      });

      console.log('[WebRTC] Sending offer to signaling server:', offerUrl);

      // Send offer to Colab via tunnel (tiny JSON exchange)
      const response = await fetch(offerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription.sdp,
          type: pc.localDescription.type
        })
      });

      if (!response.ok) {
        throw new Error(`Signaling failed: ${response.status} ${response.statusText}`);
      }

      const answer = await response.json();
      console.log('[WebRTC] Received answer from Colab, establishing connection...');
      
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('[WebRTC] Remote description set, waiting for media...');

    } catch (err) {
      console.error('[WebRTC] Connection error:', err);
      setError(err.message);
      setConnected(false);
      
      // Auto-reconnect on error
      if (mountedRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect(url);
        }, 5000);
      }
    }
  }, [cleanup]);

  // Connect when URL changes
  useEffect(() => {
    mountedRef.current = true;
    
    if (signalingUrl) {
      connect(signalingUrl);
    }

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [signalingUrl, connect, cleanup]);

  const reconnect = useCallback(() => {
    if (signalingUrl) connect(signalingUrl);
  }, [signalingUrl, connect]);

  return { videoRef, connected, error, fps, reconnect };
}

export default useWebRTCStream;
