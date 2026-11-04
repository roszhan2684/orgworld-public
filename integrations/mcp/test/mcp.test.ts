import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '@orgworld/store';
import { goldenDrafts, GOLDEN_RUN_ID } from '../../../packages/core/test/fixtures/golden-fixture.ts';
import { buildMcpServer, TOOL_LOG_RUN } from '../src/index.ts';

async function setup(mode: 'experiment' | 'sandbox') {
  const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owmcp-')), 'orgworld.db'));
  const drafts = goldenDrafts();
  if (mode === 'sandbox') (drafts[0]!.payload as any).config.mode = 'sandbox';
  store.appendMany(GOLDEN_RUN_ID, drafts.slice(0, -1)); // run still open
  const server = buildMcpServer(store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { store, client, call };
}

describe('MCP contract (build §80)', () => {
  it('lists tools with explicit schemas and read/write/exec groups', async () => {
    const { client } = await setup('sandbox');
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['orgworld_control', 'orgworld_get_agent', 'orgworld_get_budget', 'orgworld_get_state', 'orgworld_list_runs', 'orgworld_query_memory', 'orgworld_send_message', 'orgworld_write_memory', 'orgworld_why'].sort());
    for (const t of tools) expect(t.description).toMatch(/^\[(read|write|exec)\]/);
  });
  it('valid read input → result + logged; invalid input → rejected', async () => {
    const { call, store } = await setup('sandbox');
    const r = await call('orgworld_get_agent', { agentId: 'a2' });
    expect(JSON.parse(r.content[0]!.text).agent.id).toBe('a2');
    expect((await call('orgworld_get_agent', { agentId: '' })).isError).toBe(true);
    expect((await call('orgworld_get_agent', { agentId: 'ghost' })).isError).toBe(true);
    expect(store.events(TOOL_LOG_RUN).length).toBeGreaterThanOrEqual(2);
  });
  it('write tool in sandbox emits the expected event; memory carries provenance', async () => {
    const { call, store } = await setup('sandbox');
    expect((await call('orgworld_send_message', { to: 'a1', content: 'please add tests' })).isError).toBeFalsy();
    expect(store.runState(GOLDEN_RUN_ID).messageOrder.some((id) => store.runState(GOLDEN_RUN_ID).messages[id]!.from === 'user')).toBe(true);
    await call('orgworld_write_memory', { content: 'Auth tasks need rate limiting' });
    const mem = await call('orgworld_query_memory', { query: 'rate limiting auth' });
    const items = JSON.parse(mem.content[0]!.text).items;
    expect(items[0].provenance.sourceEventIds.length).toBe(1);
  });
  it('authorization: write tools refuse locked experiments and record contamination', async () => {
    const { call, store } = await setup('experiment');
    const r = await call('orgworld_send_message', { to: 'a1', content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/locked experiment/);
    expect(store.runState(GOLDEN_RUN_ID).contaminated).toBe(true);
  });
});
