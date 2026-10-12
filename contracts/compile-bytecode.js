// Build ABI and bytecode together from the full source, never a cut-down core.
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./build');
const artifact = build();
fs.writeFileSync(path.join(__dirname, 'compiled-v17.json'), JSON.stringify(artifact));
fs.writeFileSync(path.join(__dirname, 'DealArenaEscrow-v17.json'), JSON.stringify({ abi: artifact.abi }, null, 2));
console.log(`COMPILE_OK router=${artifact.runtimeBytes}, modules=${artifact.modules.length}, functions=${artifact.abi.filter((entry) => entry.type === 'function').length}`);
