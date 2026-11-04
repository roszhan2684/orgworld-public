import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { EventStore } from '../../packages/store/src/index.ts';
import { startServer, type RunningServer } from '../../packages/server/src/index.ts';
import { goldenDrafts, GOLDEN_RUN_ID } from '../../packages/core/test/fixtures/golden-fixture.ts';

/** Browser E2E (build §81) against the built web bundle (pnpm build) and the real recorded runs in evidence/live.db. */
const root = join(import.meta.dirname, '../..');
let browser: Browser, page: Page, srv: RunningServer, store: EventStore;
const REAL_RUN = 'run_phase4-specialists_mvt120ow';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owe2e-'));
  copyFileSync(join(root, 'docs/verification/evidence/live.db'), join(dir, 'orgworld.db'));
  store = EventStore.open(join(dir, 'orgworld.db'));
  srv = await startServer({ store, port: 0, webRoot: join(root, 'dist/web'), pollMs: 100 });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
});
afterAll(async () => {
  await browser?.close();
  await srv?.close();
  store?.close();
});

const ow = <T>(expr: string) => page.evaluate(`(() => { const o = window.__orgworld; return ${expr}; })()`) as Promise<T>;

describe('web world (real recorded run)', () => {
  it('renders the run and every visible agent matches backend state', async () => {
    await page.goto(`${srv.url}/#${REAL_RUN}`);
    await page.waitForFunction(() => (window as any).__orgworld?.eventCount > 0);
    const backend = await (await fetch(`${srv.url}/api/v1/runs/${REAL_RUN}/state`)).json();
    expect(await ow<number>('o.eventCount')).toBe(backend.eventCount);
    const ui = await ow<Record<string, { room: string; activitySeq: number }>>('o.agents()');
    const be = Object.fromEntries(Object.entries(backend.agents as Record<string, any>).filter(([, a]) => !a.removed).map(([id, a]) => [id, { room: a.room, status: a.status, activitySeq: a.activitySeq }]));
    expect(ui).toEqual(be);
    expect(Object.keys(await ow<Record<string, unknown>>('o.chars()')).sort()).toEqual(Object.keys(be).sort());
    await expect.poll(async () => (await page.textContent('#taskStatus')) ?? '').toContain('COMPLETED');
    await page.waitForTimeout(1500); // let agents walk to their recorded positions
    await page.screenshot({ path: join(root, 'docs/verification/evidence/web-world-3d.png') });
  });

  it('inspector, view-as-agent, scrubbing and network view work', async () => {
    const sp = await ow<{ x: number; y: number }>("o.screenPos('implementer')");
    const box = (await page.locator('#world').boundingBox())!;
    await page.mouse.click(box.x + sp.x, box.y + sp.y);
    await expect.poll(() => page.textContent('#inspector')).toContain('Implementer');
    await page.check('#viewAs');
    await expect.poll(() => page.isVisible('#hiddenNote')).toBe(true);
    await page.uncheck('#viewAs');
    await page.locator('#scrub').fill('5');
    await expect.poll(() => ow<number>('o.lastSequence')).toBe(5);
    expect(await page.textContent('#seqTxt')).toContain('replay');
    await page.click('#liveBtn');
    await expect.poll(() => ow<number | null>('o.viewSeq')).toBeNull();
    await page.click('[data-view="network"]');
    await expect.poll(() => page.locator('#netSvg circle').count()).toBe(4);
    await page.click('[data-view="metrics"]');
    await expect.poll(() => page.textContent('#metrics')).toContain('Success rate');
    await page.click('[data-view="world"]');
  });
});

describe('web world (live stream)', () => {
  it('a run appended by another writer appears live and characters follow events', async () => {
    const drafts = goldenDrafts();
    store.appendMany(GOLDEN_RUN_ID, drafts.slice(0, 6));
    await page.goto(`${srv.url}/#${GOLDEN_RUN_ID}`);
    await page.waitForFunction(() => (window as any).__orgworld?.eventCount === 6);
    store.appendMany(GOLDEN_RUN_ID, drafts.slice(6, 13)); // includes MESSAGE_SENT a1 → a2
    await expect.poll(() => ow<number>('o.eventCount'), { timeout: 5000 }).toBe(13);
    const ui = await ow<Record<string, { activitySeq: number; status: string }>>('o.agents()');
    expect(ui.a1!.status).toBe('communicating');
    expect(ui.a1!.activitySeq).toBe(13);
    expect(await page.textContent('#banner')).toContain('SCRIPTED'); // fixture provider is labelled, never passed off as real
  });
});
