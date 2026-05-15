import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';

const WebSocketContext = createContext(null);

export function WebSocketProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState('unknown');
  const [transactions, setTransactions] = useState([]);
  const wsRef = useRef(null);

  const retryRef = useRef(0);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // Backend not available — retry with backoff
      const delay = Math.min(5000 * Math.pow(2, retryRef.current), 30000);
      retryRef.current++;
      setTimeout(connect, delay);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => { setConnected(true); retryRef.current = 0; };
    ws.onclose = () => {
      setConnected(false);
      // Reconnect with exponential backoff (5s → 10s → 20s → 30s max)
      const delay = Math.min(5000 * Math.pow(2, retryRef.current), 30000);
      retryRef.current++;
      setTimeout(connect, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected') {
          setMode(msg.mode);
        } else if (msg.type === 'transaction') {
          setTransactions((prev) => [...prev.slice(-99), msg.data]); // keep last 100
        }
      } catch { /* ignore parse errors */ }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  const clearTransactions = () => setTransactions([]);

  return (
    <WebSocketContext.Provider value={{ connected, mode, transactions, clearTransactions }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be inside WebSocketProvider');
  return ctx;
}
