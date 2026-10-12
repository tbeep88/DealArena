const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { build } = require('./build');
const ROOT = path.resolve(__dirname, '..');
const deploymentTag = String(process.env.TEMPO_DEPLOYMENT_TAG || 'current').replace(/[^a-zA-Z0-9_-]/g, '-');
const JOURNAL = path.join(ROOT, '.data', `deployment-v17-${deploymentTag}.json`);

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const entry = line.trim();
  if (!entry || entry.startsWith('#')) continue;
  const index = entry.indexOf('=');
  if (index < 0) continue;
  const key = entry.slice(0, index).trim();
  if (!process.env[key]) process.env[key] = entry.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
}

async function compileContract() {
  // Rebuild instead of trusting an artifact that may belong to another source.
  const artifact = build();
  fs.writeFileSync(path.join(__dirname, 'compiled-v17.json'), JSON.stringify(artifact));
  fs.writeFileSync(path.join(__dirname, 'DealArenaEscrow-v17.json'), JSON.stringify({ abi: artifact.abi }, null, 2));
  console.log(`[Compiler] Full v17: router ${artifact.runtimeBytes} bytes, ${artifact.modules.length} fixed modules, 97 functions`);
  return artifact;
}

async function deploy(customPrivateKey = null, precompiled = null) {
  const key = customPrivateKey || process.env.TEMPO_PRIVATE_KEY;
  if (!key) throw new Error('TEMPO_PRIVATE_KEY is missing');
  const artifact = precompiled || await compileContract();
  if (artifact.format !== 'dealarena-fixed-modules-v1') throw new Error('Full fixed-module artifact required');
  const chainId = Number(process.env.TEMPO_CHAIN_ID || 42431);
  if (chainId !== 42431) throw new Error('This deployment script is dedicated to Tempo Moderato testnet');
  const rpc = process.env.TEMPO_RPC_URL || 'https://rpc.moderato.tempo.xyz';
  const token = '0x20c0000000000000000000000000000000000000';
  const provider = new ethers.JsonRpcProvider(rpc, { name: 'tempo-moderato', chainId }, { staticNetwork: true });
  if (Number(await provider.send('eth_chainId', [])) !== chainId) throw new Error('Wrong RPC chain');
  const wallet = new ethers.Wallet(key, provider);
  const signer = new ethers.NonceManager(wallet);
  let journal = fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) : { sourceHash: artifact.sourceHash, deployer: wallet.address, chainId, components: {} };
  if (journal.sourceHash !== artifact.sourceHash || journal.deployer.toLowerCase() !== wallet.address.toLowerCase() || journal.chainId !== chainId) throw new Error('Deployment journal belongs to a different build/account/chain');
  const save = () => {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    fs.writeFileSync(`${JOURNAL}.tmp`, JSON.stringify(journal, null, 2));
    fs.renameSync(`${JOURNAL}.tmp`, JOURNAL);
  };
  try { await provider.send('tempo_fundAddress', [wallet.address]); } catch { console.log('[Deploy] Faucet unavailable; using existing testnet balance'); }
  async function component(name, abi, bytecode, args) {
    const factory = new ethers.ContractFactory(abi, bytecode, signer);
    const expectedInput = (await factory.getDeployTransaction(...args)).data;
    let entry = journal.components[name];
    if (!entry) {
      const contract = await factory.deploy(...args, { gasLimit: 30_000_000 });
      entry = { hash: contract.deploymentTransaction().hash, expectedInputHash: ethers.keccak256(expectedInput) };
      journal.components[name] = entry;
      save();
      console.log(`[Deploy] ${name} broadcast ${entry.hash}`);
    }
    if (entry.expectedInputHash !== ethers.keccak256(expectedInput)) throw new Error(`${name}: journal bytecode/constructor mismatch`);
    const receipt = await provider.waitForTransaction(entry.hash, 1, 180000);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress) throw new Error(`${name}: deployment not confirmed`);
    const tx = await provider.getTransaction(entry.hash);
    if (!tx || tx.from.toLowerCase() !== wallet.address.toLowerCase() || tx.data.toLowerCase() !== expectedInput.toLowerCase()) throw new Error(`${name}: deployment transaction differs from built source`);
    const code = await provider.getCode(receipt.contractAddress);
    if (code === '0x' || (code.length - 2) / 2 > 24576) throw new Error(`${name}: invalid deployed code`);
    if (entry.codeHash && entry.codeHash !== ethers.keccak256(code)) throw new Error(`${name}: deployed code changed`);
    Object.assign(entry, { address: receipt.contractAddress, codeHash: ethers.keccak256(code), blockNumber: receipt.blockNumber, runtimeBytes: (code.length - 2) / 2 });
    save();
    console.log(`[Deploy] ${name} confirmed ${entry.address} (${entry.runtimeBytes} bytes)`);
    return entry;
  }
  const modules = [];
  for (const module of artifact.modules) modules.push({ name: module.name, selectors: module.selectors, ...await component(module.name, module.abi, module.bytecode, []) });
  const router = await component('DealArenaRouter', artifact.abi, artifact.bytecode, [token, wallet.address, modules.map((m) => m.address), modules.map((m) => m.selectors)]);
  const contract = new ethers.Contract(router.address, artifact.abi, signer);
  if (Number(await contract.CONTRACT_VERSION()) !== 17 || (await contract.owner()).toLowerCase() !== wallet.address.toLowerCase() || (await contract.paymentToken()).toLowerCase() !== token.toLowerCase()) throw new Error('Router state verification failed');
  const roles = [['SELLER_A', 1], ['SELLER_B', 4], ['SELLER_C', 5], ['SUPPLIER_A', 6], ['SUPPLIER_B', 7], ['SUPPLIER_C', 8]];
  for (const [role, index] of roles) {
    const actorKey = process.env[`TEMPO_DEMO_${role}_PRIVATE_KEY`];
    const mnemonic = String(process.env.TEMPO_DEMO_MNEMONIC || '').trim();
    const address = actorKey ? new ethers.Wallet(actorKey).address : mnemonic ? ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`).address : null;
    if (address && !(await contract.authorizedSellers(address))) await (await contract.setSellerAuthorization(address, true)).wait();
  }
  const deployed = { contractVersion: 17, architecture: artifact.format, sourceHash: artifact.sourceHash, contractAddress: router.address, txHash: router.hash, blockNumber: router.blockNumber, deployer: wallet.address, walletAddress: wallet.address, pathUsdAddress: token, network: 'Tempo Testnet (Moderato)', chainId, rpc, explorer: 'https://explore.testnet.tempo.xyz', modules: modules.map(({ expectedInputHash, ...m }) => m), abi: artifact.abi };
  // Publish only after every module, router and critical state is verified.
  fs.writeFileSync(path.join(__dirname, 'deployed.json.tmp'), JSON.stringify(deployed, null, 2));
  fs.renameSync(path.join(__dirname, 'deployed.json.tmp'), path.join(__dirname, 'deployed.json'));
  console.log(`[Deploy] VERIFIED v17 ${router.address}`);
  return deployed;
}

if (require.main === module) deploy().then(() => process.exit(0)).catch((error) => {
  console.error('[Deploy]', error.shortMessage || error.message);
  process.exit(1);
});
module.exports = { compileContract, deploy };
