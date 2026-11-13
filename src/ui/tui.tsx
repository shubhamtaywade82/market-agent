import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import http from 'node:http';
import type { UiSnapshot, UiSymbolState, UiDeskState, UiEvent } from './server';

const UI_URL = process.env.UI_URL || 'http://127.0.0.1:3800';

function SymbolRow({ s }: { s: UiSymbolState }) {
  const isStale = s.stale && s.stale.length > 0;
  const staleText = isStale ? s.stale.join(',') : 'LIVE';
  const price = s.mark.toFixed(s.symbol.includes('XRP') ? 4 : 2);
  return (
    <Box>
      <Box width={12}><Text bold color="cyan">{s.symbol}</Text></Box>
      <Box width={14}><Text bold color="yellow">{price}</Text></Box>
      <Box width={26}><Text color="blue">{s.regime}</Text></Box>
      <Box width={10}><Text color={isStale ? 'red' : 'green'}>{staleText}</Text></Box>
    </Box>
  );
}

function DeskPanel({ desk }: { desk: UiDeskState | null }) {
  if (!desk) return <Text dimColor>Waiting for risk desk telemetry...</Text>;
  const dayR = Number(desk.dayR) || 0;
  const rColor = dayR > 0 ? 'green' : dayR < 0 ? 'red' : 'white';
  const rSign = dayR >= 0 ? '+' : '';
  const dd = Math.max(0, (Number(desk.peakR) || 0) - (Number(desk.cumR) || 0));
  const exp = desk.exposure || { positions: 0, riskUnits: 0 };
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="magenta">Risk Desk Status ({desk.mode})</Text>
      <Box gap={2} marginTop={1}>
        <Text>Day PnL: <Text color={rColor} bold>{rSign}{dayR.toFixed(2)} R</Text></Text>
        <Text>Drawdown: <Text bold color={dd > 3 ? 'red' : 'white'}>{dd.toFixed(2)} R</Text></Text>
        <Text>Loss Streak: <Text bold>{desk.consecLosses ?? 0}</Text></Text>
        <Text>Exposure: <Text bold color="cyan">{exp.positions} pos / {exp.riskUnits} R</Text></Text>
      </Box>
    </Box>
  );
}

function EventLine({ ev }: { ev: UiEvent }) {
  const time = (ev.t || '').slice(11, 19);
  const color = ev.level === 'error' ? 'red' : ev.level === 'warn' ? 'yellow' : 'cyan';
  let summary = ev.msg;
  if (ev.msg === 'heartbeat') summary = `${ev.symbol} @ ${ev.mark} (${ev.regime})`;
  else if (ev.msg === 'desk') summary = `mode=${ev.mode} dayR=${ev.dayR}`;
  return (
    <Box gap={1}>
      <Text dimColor>[{time}]</Text>
      <Text color={color} bold>{(ev.level || 'INFO').toUpperCase().padEnd(5)}</Text>
      <Text>{summary}</Text>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [connected, setConnected] = useState(false);
  const [killed, setKilled] = useState(false);
  const [symbols, setSymbols] = useState<Record<string, UiSymbolState>>({});
  const [desk, setDesk] = useState<UiDeskState | null>(null);
  const [events, setEvents] = useState<UiEvent[]>([]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      process.stdout.write('\x1b[?1049l');
      exit();
    }
    if (input === 'k') {
      const req = http.request(`${UI_URL}/api/kill`, { method: 'POST' });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try { setKilled(JSON.parse(body).killed); } catch { /* ignore */ }
        });
      });
      req.on('error', () => {});
      req.end();
    }
  });

  useEffect(() => {
    let active = true;
    const req = http.get(`${UI_URL}/api/stream`, (res) => {
      if (res.statusCode !== 200) { setConnected(false); return; }
      setConnected(true);
      let buf = '';
      res.on('data', (chunk) => {
        if (!active) return;
        buf += chunk.toString();
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === 'snapshot') {
              const snap = parsed.data as UiSnapshot;
              setKilled(snap.killed);
              setSymbols(snap.symbols || {});
              setDesk(snap.desk);
              setEvents(snap.events || []);
            } else if (parsed.type === 'event') {
              const ev = parsed.event as UiEvent;
              // High-frequency price ticks update ticker cards, not the event history log
              if (ev.msg !== 'tick') {
                setEvents((prev) => [...prev.slice(-9), ev]);
              }
              if ((ev.msg === 'heartbeat' || ev.msg === 'tick') && typeof ev.symbol === 'string') {
                setSymbols((prev) => ({
                  ...prev,
                  [ev.symbol as string]: {
                    symbol: ev.symbol as string,
                    mark: Number(ev.mark) || 0,
                    regime: String(ev.regime || ''),
                    stale: Array.isArray(ev.stale) ? (ev.stale as string[]) : [],
                    updatedAt: Date.now(),
                  },
                }));
              } else if (ev.msg === 'desk') {
                setDesk(ev as unknown as UiDeskState);
              }
            } else if (parsed.type === 'kill') {
              setKilled(Boolean(parsed.killed));
            }
          } catch { /* ignore parse error */ }
        }
      });
      res.on('close', () => { if (active) setConnected(false); });
    });
    req.on('error', () => { if (active) setConnected(false); });
    return () => { active = false; req.destroy(); };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="green">MARKET-AGENT TERMINAL COCKPIT</Text>
        <Box gap={2}>
          <Text color={connected ? 'green' : 'red'}>{connected ? '● LIVE' : '○ CONNECTING...'}</Text>
          <Text color={killed ? 'red' : 'green'} bold>{killed ? '[KILL ACTIVE]' : '[SAFE]'}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Box marginBottom={1}>
          <Box width={12}><Text bold underline>Symbol</Text></Box>
          <Box width={14}><Text bold underline>Mark Price</Text></Box>
          <Box width={26}><Text bold underline>Regime</Text></Box>
          <Box width={10}><Text bold underline>Status</Text></Box>
        </Box>
        {Object.values(symbols).length === 0 ? (
          <Text dimColor>Awaiting symbol ticks from runner...</Text>
        ) : (
          Object.values(symbols).map((s) => <SymbolRow key={s.symbol} s={s} />)
        )}
      </Box>

      <DeskPanel desk={desk} />

      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Text bold color="yellow">Live Activity Feed</Text>
        {events.slice(-6).map((ev, i) => (
          <EventLine key={ev.t || i} ev={ev} />
        ))}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text dimColor>[k] Toggle Kill Switch</Text>
        <Text dimColor>[q] Exit TUI</Text>
        <Text dimColor>URL: {UI_URL}</Text>
      </Box>
    </Box>
  );
}

// Enter alternate screen buffer to prevent cluttering terminal scrollback
process.stdout.write('\x1b[?1049h\x1b[H');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));

render(<App />);
