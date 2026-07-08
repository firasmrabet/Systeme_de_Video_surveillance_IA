import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';
import toast from 'react-hot-toast';

const SocketContext = createContext(null);

const SOCKET_URL = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

export function SocketProvider({ children }) {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const { isAuthenticated, token } = useAuth();

  useEffect(() => {
    if (!isAuthenticated || !token) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    const newSocket = io(SOCKET_URL, {
      auth: { token },
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    newSocket.on('connect', () => {
      console.log('Socket connected');
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Socket disconnected');
      setConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
    });

    // Listen for global alerts
    newSocket.on('global-alert', (alert) => {
      const severityColors = {
        critical: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
      };

      toast.custom((t) => (
        <div
          className={`${
            t.visible ? 'animate-enter' : 'animate-leave'
          } max-w-md w-full bg-slate-800 shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}
          style={{ borderLeft: `4px solid ${severityColors[alert.severity] || '#f59e0b'}` }}
        >
          <div className="flex-1 p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                {alert.severity === 'critical' ? (
                  <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                ) : (
                  <svg className="h-6 w-6 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                )}
              </div>
              <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-white">
                  {alert.type.replace(/_/g, ' ').toUpperCase()}
                </p>
                <p className="mt-1 text-sm text-slate-300">
                  Confidence: {(alert.confidence * 100).toFixed(1)}%
                </p>
              </div>
            </div>
          </div>
          <div className="flex border-l border-slate-700">
            <button
              onClick={() => toast.dismiss(t.id)}
              className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-sm font-medium text-slate-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        </div>
      ), {
        duration: 10000,
        position: 'top-right'
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [isAuthenticated, token]);

  const subscribeToCamera = useCallback((cameraId) => {
    if (socket) {
      socket.emit('subscribe-camera', cameraId);
    }
  }, [socket]);

  const unsubscribeFromCamera = useCallback((cameraId) => {
    if (socket) {
      socket.emit('unsubscribe-camera', cameraId);
    }
  }, [socket]);

  const startDetection = useCallback((cameraId) => {
    if (socket) {
      socket.emit('start-detection', cameraId);
    }
  }, [socket]);

  const stopDetection = useCallback((cameraId) => {
    if (socket) {
      socket.emit('stop-detection', cameraId);
    }
  }, [socket]);

  const subscribeLive = useCallback((cameraId, subId = 'default') => {
    if (socket) {
      socket.emit('subscribe-live', { cameraId, subId });
    }
  }, [socket]);

  const unsubscribeLive = useCallback((cameraId, subId = 'default') => {
    if (socket) {
      socket.emit('unsubscribe-live', { cameraId, subId });
    }
  }, [socket]);

  const value = {
    socket,
    connected,
    subscribeToCamera,
    unsubscribeFromCamera,
    startDetection,
    stopDetection,
    subscribeLive,
    unsubscribeLive
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
