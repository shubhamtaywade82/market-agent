import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UiSnapshot, UiSymbolState, UiDeskState, UiEvent } from './server';

try { process.loadEnvFile?.(); } catch {}

function getCandidates(): string[] {
  if (process.env.UI_URL) return [process.env.UI_URL];
  const list: string[] = [];
  try {
    const p = join(process.env.DATA_DIR || 'data', 'ui-url.txt');
    if (existsSync(p)) {
      const u = readFileSync(p, 'utf8').trim();
      if (u.startsWith('http')) list.push(u);
    }
  } catch {}
  const port = Number(process.env.UI_PORT) || 3800;
  for (let o = 0; o <= 4; o++) {
    const u = `http://127.0.0.1:${port + o}`;
    if (!list.includes(u)) list.push(u);
  }
  return list;
}

function aiStatus(s: UiSymbolState): { text: string; color: string } {
  if (s.aiThinking) return { text: 'Thinking...', color: 'yellow' };
  if (!s.aiDecision) return { text: 'STANDBY', color: 'gray' };
  const { action, setup, accepted, rejectReason } = s.aiDecision;
  if (action === 'NO_TRADE') return { text: 'NO_TRADE', color: 'gray' };
  const res = accepted ? 'OK' : rejectReason ? `REJ:${rejectReason}` : 'REJ';
  return { text: `${action} (${setup}) [${res}]`, color: action.includes('LONG') ? 'green' : 'red' };
}

function SymbolRow({ s, cols }: { s: UiSymbolState; cols: number }) {
  const isStale = s.stale && s.stale.length > 0;
  const price = s.mark.toFixed(s.symbol.includes('XRP') ? 4 : 2);
  const reg = cols < 80 ? s.regime.replace('TREND_', '').replace('EXPANSION', 'EXP') : s.regime;
  const ai = aiStatus(s);
  return (
    <Box>
      <Box width={cols < 80 ? 10 : 12}><Text bold color="cyan">{s.symbol}</Text></Box>
      <Box width={cols < 80 ? 11 : 13}><Text bold color="yellow">{price}</Text></Box>
      <Box width={cols < 80 ? 16 : 22}><Text color="blue">{reg}</Text></Box>
      <Box width={cols < 80 ? 22 : 32}><Text color={ai.color} bold={ai.color !== 'gray'}>{ai.text}</Text></Box>
      <Box width={8}><Text color={isStale ? 'red' : 'green'}>{isStale ? s.stale.join(',') : 'LIVE'}</Text></Box>
    </Box>
  );
}

function DeskPanel({ desk, connected, cols }: { desk: UiDeskState | null; connected: boolean; cols: number }) {
  if (!connected) return <Text dimColor>Risk desk: waiting for engine connection...</Text>;
  if (!desk) return <Text dimColor>Risk desk: synchronizing state...</Text>;
  const dayR = Number(desk.dayR) || 0, rColor = dayR > 0 ? 'green' : dayR < 0 ? 'red' : 'white';
  const dd = Math.max(0, (Number(desk.peakR) || 0) - (Number(desk.cumR) || 0));
  const exp = desk.exposure || { positions: 0, riskUnits: 0 };
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold color="magenta">Desk ({desk.mode})</Text>
      <Box gap={cols < 80 ? 1 : 2}>
        <Text>Day: <Text color={rColor} bold>{dayR >= 0 ? '+' : ''}{dayR.toFixed(2)} R</Text></Text>
        <Text>DD: <Text bold color={dd > 3 ? 'red' : 'white'}>{dd.toFixed(2)} R</Text></Text>
        <Text>Streak: <Text bold>{desk.consecLosses ?? 0}</Text></Text>
        <Text>Exp: <Text bold color="cyan">{exp.positions} pos / {exp.riskUnits} R</Text></Text>
      </Box>
    </Box>
  );
}

function EventContent({ ev }: { ev: UiEvent }) {
  if (ev.msg === 'heartbeat') {
    return (
      <Box gap={1}>
        <Text color="cyan" bold>{String(ev.symbol)}</Text>
        <Text dimColor>@</Text><Text color="yellow" bold>{String(ev.mark)}</Text>
        <Text color="magenta">({String(ev.regime)})</Text>
      </Box>
    );
  }
  if (ev.msg === 'ai_thinking') {
    return (
      <Box gap={1}>
        <Text color="yellow" bold>AI THINKING</Text><Text color="cyan" bold>{String(ev.symbol)}</Text>
        <Text dimColor>with</Text><Text color="magenta">{String(ev.model || 'ollama')}</Text>
      </Box>
    );
  }
  if (ev.msg === 'decision') {
    const act = String(ev.action || 'NO_TRADE');
    const col = act.includes('LONG') ? 'green' : act.includes('SHORT') ? 'red' : 'gray';
    const st = ev.accepted ? 'ACCEPTED' : `REJ (${String(ev.rejectReason || 'RISK')})`;
    return (
      <Box gap={1}>
        <Text color="magenta" bold>AI DECISION</Text><Text color="cyan" bold>{String(ev.symbol)}</Text>
        <Text color={col} bold>{act}</Text><Text dimColor>({String(ev.setup || 'NONE')})</Text>
        <Text color={ev.accepted ? 'green' : 'yellow'}>{st}</Text><Text dimColor>{String(ev.latencyMs)}ms</Text>
      </Box>
    );
  }
  if (ev.msg === 'desk') {
    const dayR = Number(ev.dayR) || 0, col = dayR > 0 ? 'green' : dayR < 0 ? 'red' : 'white';
    return (
      <Box gap={1}>
        <Text color="magenta" bold>{String(ev.mode)}</Text>
        <Text dimColor>DayR=</Text><Text color={col} bold>{dayR >= 0 ? '+' : ''}{dayR.toFixed(2)} R</Text>
      </Box>
    );
  }
  if (ev.msg === 'trade_closed') {
    const r = Number(ev.r) || 0, col = r > 0 ? 'green' : r < 0 ? 'red' : 'yellow';
    return (
      <Box gap={1}>
        <Text color="red" bold>TRADE CLOSED</Text><Text color="cyan" bold>{String(ev.symbol)}</Text>
        <Text color={col} bold>{r >= 0 ? '+' : ''}{String(ev.r)} R</Text><Text dimColor>exit={String(ev.exit)}</Text>
      </Box>
    );
  }
  return <Text>{ev.msg}</Text>;
}

function EventLine({ ev }: { ev: UiEvent }) {
  const color = ev.level === 'error' ? 'red' : ev.level === 'warn' ? 'yellow' : 'cyan';
  return (
    <Box gap={1}>
      <Text dimColor>[{(ev.t || '').slice(11, 19)}]</Text>
      <Text color={color} bold>{(ev.level || 'INFO').toUpperCase().padEnd(5)}</Text>
      <EventContent ev={ev} />
    </Box>
  );
}

function updateSym(prev: Record<string, UiSymbolState>, ev: UiEvent): Record<string, UiSymbolState> {
  const sym = String(ev.symbol || '');
  if (!sym) return prev;
  const cur = prev[sym] || { symbol: sym, mark: 0, regime: '', stale: [], updatedAt: Date.now() };
  if (ev.msg === 'heartbeat' || ev.msg === 'tick') {
    return { ...prev, [sym]: { ...cur, mark: Number(ev.mark) || 0, regime: String(ev.regime || ''), stale: Array.isArray(ev.stale) ? ev.stale as string[] : [], updatedAt: Date.now() } };
  }
  if (ev.msg === 'ai_thinking') return { ...prev, [sym]: { ...cur, aiThinking: true } };
  if (ev.msg === 'decision') {
    return {
      ...prev,
      [sym]: {
        ...cur,
        aiThinking: false,
        aiDecision: {
          action: String(ev.action || 'NO_TRADE'),
          setup: String(ev.setup || 'NONE'),
          accepted: Boolean(ev.accepted),
          rejectReason: ev.rejectReason ? String(ev.rejectReason) : null,
          latencyMs: Number(ev.latencyMs) || 0,
        },
      },
    };
  }
  return prev;
}

function App() {
  const { exit } = useApp();
  const [dimensions, setDimensions] = useState({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const [url, setUrl] = useState(getCandidates()[0] || 'http://127.0.0.1:3800');
  const [connected, setConnected] = useState(false);
  const [killed, setKilled] = useState(false);
  const [symbols, setSymbols] = useState<Record<string, UiSymbolState>>({});
  const [desk, setDesk] = useState<UiDeskState | null>(null);
  const [events, setEvents] = useState<UiEvent[]>([]);

  useEffect(() => {
    const onResize = () => {
      setDimensions({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
      process.stdout.write('\x1b[2J\x1b[H');
    };
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);

  const applyPayload = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'snapshot') {
        const snap = parsed.data as UiSnapshot;
        setKilled(snap.killed);
        setSymbols(snap.symbols || {});
        setDesk(snap.desk);
        setEvents(snap.events || []);
      } else if (parsed.type === 'event') {
        const ev = parsed.event as UiEvent;
        if (ev.msg !== 'tick') setEvents((prev) => [...prev.slice(-15), ev]);
        if (ev.symbol) setSymbols((prev) => updateSym(prev, ev));
        else if (ev.msg === 'desk') setDesk(ev as unknown as UiDeskState);
      } else if (parsed.type === 'kill') {
        setKilled(Boolean(parsed.killed));
      }
    } catch {}
  };

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { process.stdout.write('\x1b[?1049l'); exit(); }
    if (input === 'k') {
      http.request(`${url}/api/kill`, { method: 'POST' }, (res) => {
        let b = '';
        res.on('data', (c) => b += c);
        res.on('end', () => { try { setKilled(JSON.parse(b).killed); } catch {} });
      }).on('error', () => {}).end();
    }
  }, { isActive: Boolean(process.stdin.isTTY) });

  useEffect(() => {
    let active = true, timer: NodeJS.Timeout | null = null, req: http.ClientRequest | null = null;
    let candIdx = 0;
    const scheduleRetry = () => {
      if (!active || timer) return;
      timer = setTimeout(() => { timer = null; connect(); }, 1000);
    };
    const connect = () => {
      if (!active) return;
      const cands = getCandidates();
      const targetUrl = cands[candIdx % cands.length]!;
      candIdx++;
      setUrl(targetUrl);
      try {
        req = http.get(`${targetUrl}/api/stream`, (res) => {
          if (res.statusCode !== 200) { setConnected(false); scheduleRetry(); return; }
          candIdx = cands.indexOf(targetUrl);
          setConnected(true);
          let buf = '';
          res.on('data', (chunk) => {
            if (!active) return;
            buf += chunk.toString();
            const lines = buf.split('\n\n');
            buf = lines.pop() || '';
            for (const line of lines) if (line.startsWith('data: ')) applyPayload(line.slice(6));
          });
          res.on('close', () => { if (active) { setConnected(false); scheduleRetry(); } });
        }).on('error', () => { if (active) { setConnected(false); scheduleRetry(); } });
      } catch { scheduleRetry(); }
    };
    connect();
    return () => { active = false; if (timer) clearTimeout(timer); req?.destroy(); };
  }, []);

  const symbolCount = Math.max(1, Object.keys(symbols).length);
  const maxEvents = Math.max(1, Math.min(25, dimensions.rows - (11 + symbolCount)));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="green">MARKET-AGENT TERMINAL COCKPIT</Text>
        <Box gap={2}>
          <Text color={connected ? 'green' : 'yellow'}>{connected ? '● LIVE' : '○ CONNECTING (retrying...)'}</Text>
          <Text color={killed ? 'red' : 'green'} bold>{killed ? '[KILL ACTIVE]' : '[SAFE]'}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Box>
          <Box width={dimensions.columns < 80 ? 10 : 12}><Text bold underline>Symbol</Text></Box>
          <Box width={dimensions.columns < 80 ? 11 : 13}><Text bold underline>Mark Price</Text></Box>
          <Box width={dimensions.columns < 80 ? 16 : 22}><Text bold underline>Regime</Text></Box>
          <Box width={dimensions.columns < 80 ? 22 : 32}><Text bold underline>AI Analyst Intent</Text></Box>
          <Box width={8}><Text bold underline>Status</Text></Box>
        </Box>
        {Object.values(symbols).length === 0 ? (
          <Text dimColor>
            {connected ? 'Awaiting symbol ticks from runner...' : 'Runner offline. Run "npm start" in another terminal.'}
          </Text>
        ) : (
          Object.values(symbols).map((s) => <SymbolRow key={s.symbol} s={s} cols={dimensions.columns} />)
        )}
      </Box>

      <DeskPanel desk={desk} connected={connected} cols={dimensions.columns} />

      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold color="yellow">Live Activity Feed</Text>
        {events.slice(-maxEvents).map((ev, i) => (
          <EventLine key={ev.t ? `${ev.t}-${i}` : i} ev={ev} />
        ))}
      </Box>

      <Box justifyContent="space-between">
        <Box gap={2}>
          <Text dimColor>[k] Toggle Kill</Text>
          <Text dimColor>[q] Exit</Text>
        </Box>
        <Text dimColor>{url} ({dimensions.columns}x{dimensions.rows})</Text>
      </Box>
    </Box>
  );
}

process.stdout.write('\x1b[?1049h\x1b[H');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));

render(<App />);
