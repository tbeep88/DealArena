const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const deployedPath = path.join(dir, 'deployed.json');
const deployed = JSON.parse(fs.readFileSync(deployedPath, 'utf8'));
const abiFile = Number(deployed.contractVersion || 0) >= 17 ? 'DealArenaEscrow-v17.json' : Number(deployed.contractVersion || 0) >= 16 ? 'DealArenaEscrow-v16.json' : Number(deployed.contractVersion || 0) >= 15 ? 'DealArenaEscrow-v15.json' : Number(deployed.contractVersion || 0) >= 14 ? 'DealArenaEscrow-v14.json' : Number(deployed.contractVersion || 0) >= 13 ? 'DealArenaEscrow-v13.json' : Number(deployed.contractVersion || 0) >= 12 ? 'DealArenaEscrow-v12.json' : Number(deployed.contractVersion || 0) >= 11 ? 'DealArenaEscrow-v11.json' : 'DealArenaEscrow.json';
const abiPath = path.join(dir, abiFile);
const { abi } = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
deployed.abi = abi;
fs.writeFileSync(deployedPath, JSON.stringify(deployed, null, 2) + '\n');
console.log(`DEPLOYED_ABI_SYNCED functions=${abi.filter((item) => item.type === 'function').length}`);
