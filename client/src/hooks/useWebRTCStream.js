import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useWebRTCStream — Loopback WebRTC (Zero Tunnel)
 * 
 * - React sends a local VideoTrack to Colab via WebRTC P2P
 * - Colab processes it and sends it back via the same WebRTC connection
 * - Signaling uses ntfy.sh file attachments (PUT + X-Filename)
 *   to avoid the 4KB message size limit
 */
export function useWebRTCStream() {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [fps, setFps] = useState(0);
  const mountedRef = useRef(true);
  const fpsCounterRef = useRef({ count: 0, lastTime: Date.now() });

  const NTFY_OFFER_TOPIC = "sentinelai_firas_webrtc_offer";
  const NTFY_ANSWER_TOPIC = "sentinelai_firas_webrtc_answer";
  const eventSourceRef = useRef(null);

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
  }, []);

  const connectLoopback = useCallback(async (localStream) => {
    if (!localStream || !mountedRef.current) return;

    cleanup();
    setError(null);
    setConnected(false);

    try {
      console.log('[WebRTC Loopback] Creating peer connection...');

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: [
              'turn:openrelay.metered.ca:80',
              'turn:openrelay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceCandidatePoolSize: 4
      });
      pcRef.current = pc;

      // 1. Add local track (React -> Colab)
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });

      // 2. Receive remote track (Colab -> React)
      pc.ontrack = (event) => {
        console.log('[WebRTC Loopback] Received annotated video track from Colab!');
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
          
          const track = event.streams[0].getVideoTracks()[0];
          if (track) {
            const interval = setInterval(() => {
              if (!mountedRef.current || pc.connectionState === 'closed') {
                clearInterval(interval);
                return;
              }
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
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[WebRTC Loopback] Connection state: ${state}`);
        if (state === 'connected') {
          setConnected(true);
          setError(null);
        } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          setConnected(false);
          if (eventSourceRef.current) eventSourceRef.current.close();
        }
      };

      // 3. Purge old messages from ntfy topics (avoid stale offers/answers)
      console.log('[WebRTC Loopback] Purging old ntfy messages...');
      await fetch(`https://ntfy.sh/${NTFY_ANSWER_TOPIC}/purge`, { method: 'DELETE' }).catch(() => {});
      await fetch(`https://ntfy.sh/${NTFY_OFFER_TOPIC}/purge`, { method: 'DELETE' }).catch(() => {});

      // 4. Listen for Answer on ntfy.sh via SSE (BEFORE sending offer)
      const listenUrl = `https://ntfy.sh/${NTFY_ANSWER_TOPIC}/sse`;
      const eventSource = new EventSource(listenUrl);
      eventSourceRef.current = eventSource;
      
      eventSource.onmessage = async (e) => {
        try {
          // Ignore if already connected or wrong state
          if (!pcRef.current || pcRef.current.signalingState !== 'have-local-offer') return;
          
          const data = JSON.parse(e.data);
          let answerPayload = null;
          
          // ntfy.sh always sends as attachment when using PUT + X-Filename
          if (data.attachment && data.attachment.url) {
            console.log('[WebRTC Loopback] Downloading answer attachment from ntfy...');
            const attRes = await fetch(data.attachment.url);
            answerPayload = await attRes.json();
          } else if (data.message) {
            try {
              const parsed = JSON.parse(data.message);
              if (parsed.sdp) answerPayload = parsed;
            } catch(_) { /* not JSON, ignore */ }
          }

          if (answerPayload && answerPayload.sdp) {
            console.log('[WebRTC Loopback] Received Answer from Colab via ntfy!');
            
            // Double-check state before applying
            if (pcRef.current && pcRef.current.signalingState === 'have-local-offer') {
               await pcRef.current.setRemoteDescription(new RTCSessionDescription({
                 type: answerPayload.type,
                 sdp: answerPayload.sdp
               }));
               console.log('[WebRTC Loopback] Remote description set! P2P connection starting...');
            }
          }
        } catch (err) {
          // Ignore WrongState errors (race condition with multiple answers)
          if (err.name === 'InvalidStateError') {
            console.warn('[WebRTC Loopback] Answer ignored (wrong state, likely duplicate)');
          } else {
            console.error("Error parsing ntfy answer:", err);
          }
        }
      };

      // 4. Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timeout = setTimeout(resolve, 5000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            resolve();
          }
        };
      });

      // 5. Send Offer to Colab via ntfy.sh as a FILE ATTACHMENT
      //    Using PUT + X-Filename to avoid the 4KB message limit
      console.log('[WebRTC Loopback] Sending Offer to Colab via ntfy.sh (as attachment)...');
      const offerPayload = {
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type
      };
      
      const response = await fetch(`https://ntfy.sh/${NTFY_OFFER_TOPIC}`, {
        method: 'PUT',
        headers: {
          'Filename': 'offer.json',
          'Title': 'webrtc_offer'
        },
        body: JSON.stringify(offerPayload)
      });
      
      if (response.ok) {
        console.log('[WebRTC Loopback] Offer sent successfully as attachment!');
      } else {
        console.error('[WebRTC Loopback] Failed to send offer:', response.status, await response.text());
      }

    } catch (err) {
      console.error('[WebRTC Loopback] Error:', err);
      setError(err.message);
      setConnected(false);
    }
  }, [cleanup]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  return { videoRef, connected, error, fps, connectLoopback, cleanup };
}

export default useWebRTCStream;
