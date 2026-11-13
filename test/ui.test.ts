import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiServer, type UiServerInstance } from '../src/ui/server';

describe('UI Server', () => {
  let instance: UiServerInstance | null = null;
  let dir = '';

  const setup = (port = 3456): UiServerInstance => {
    dir = mkdtempSync(join(tmpdir(), 'ui-test-'));
    instance = createUiServer(port, dir);
    return instance;
  };

  afterEach(async () => {
    if (instance) await instance.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves dashboard HTML on GET /', async () => {
    setup();
    const res = await fetch('http://127.0.0.1:3456/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MARKET-AGENT COCKPIT');
  });

  it('serves snapshot on GET /api/state', async () => {
    const srv = setup(3457);
    srv.publish({
      t: new Date().toISOString(),
      level: 'info',
      msg: 'heartbeat',
      symbol: 'SOLUSDT',
      mark: 80.5,
      regime: 'TREND_UP',
      stale: [],
    });
    const res = await fetch('http://127.0.0.1:3457/api/state');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.symbols.SOLUSDT).toBeDefined();
    expect(data.symbols.SOLUSDT.mark).toBe(80.5);
    expect(data.killed).toBe(false);
  });

  it('toggles kill switch on POST /api/kill', async () => {
    setup(3458);
    const res1 = await fetch('http://127.0.0.1:3458/api/kill', { method: 'POST' });
    const data1 = await res1.json();
    expect(data1.killed).toBe(true);

    const res2 = await fetch('http://127.0.0.1:3458/api/kill', { method: 'POST' });
    const data2 = await res2.json();
    expect(data2.killed).toBe(false);
  });

  it('automatically falls back to next port when EADDRINUSE occurs', async () => {
    const srv1 = setup(3459);
    const dir2 = mkdtempSync(join(tmpdir(), 'ui-test-fallback-'));
    let boundPort = 0;
    const srv2 = createUiServer(3459, dir2, (p) => {
      boundPort = p;
    });

    // Give it a brief moment to catch EADDRINUSE and retry next port
    await new Promise((r) => setTimeout(r, 100));
    expect(boundPort).toBe(3460);
    expect(srv2.port).toBe(3460);

    await srv2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});
