#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EventStore } from '@orgworld/store';
import { buildMcpServer, dbPathFromEnv } from './tools.ts';

const store = EventStore.open(dbPathFromEnv());
await buildMcpServer(store).connect(new StdioServerTransport());
