#!/usr/bin/env node
import { startWormholeService } from './server.js';

const port = Number(process.env.PORT ?? 8787);
const server = startWormholeService({ port });
console.log(`@wormhole/service listening on http://localhost:${port}`);
process.on('SIGINT', () => server.close(() => process.exit(0)));
