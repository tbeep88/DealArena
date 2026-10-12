const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const solc = require('solc');
const { ethers } = require('ethers');

const SOURCE_PATH = path.join(__dirname, 'DealArenaEscrow.sol');
const MAX_RUNTIME_BYTES = 24576;
const MAX_INITCODE_BYTES = 49152;
const GROUPS = {
  DealFunding: ['joinDeal', 'joinDealUnits', 'submitOfferWithCapacity', 'submitPriceLadder', 'topUpDeal'],
  DealClosing: ['settleDeal', 'finalizeDealAfterDeadline', 'settleDealAfterDeadline', 'removeUnfundedDealBuyers', 'removeUnfundedDealBuyersAfterDeadline', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline', 'disburseSurplusBatch', 'refundDeal', 'refundDealAfterDeadline', 'refundBatch', 'slashSellerGuarantee'],
  Business: ['joinBusinessPool', 'submitBusinessOffer', 'submitBusinessOfferWithCapacity', 'settleBusinessPool', 'finalizeBusinessPoolAfterDeadline', 'refundBusinessPool', 'refundBusinessPoolAfterDeadline', 'refundBusinessBatch', 'disburseBusinessSavings', 'sweepBusinessSavingsDust'],
  Request: ['createRequest', 'joinRequest', 'fundRequest', 'submitRequestOffer', 'submitRequestOfferWithCapacity', 'settleRequest', 'finalizeRequestAfterDeadline', 'removeUnfundedRequestBuyersAfterDeadline', 'disburseRequestSurplusBatch', 'sweepRequestSurplusDust', 'refundRequest', 'refundRequestAfterDeadline', 'refundRequestBatch'],
  SupplierDelivery: ['confirmSupplierFulfillment', 'slashSettledSupplierGuarantee', 'slashBusinessSupplierAfterFulfillmentDeadline', 'slashRequestSupplierAfterFulfillmentDeadline'],
};

function compile(input) {
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  return output;
}

// Every module is generated from the complete source. No money rule or market
// function is deleted to meet the chain's size limit. The fixed router exposes
// the same ABI at one address and cannot be upgraded or re-routed after deploy.
function build() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const bytes = Buffer.from(source);
  const parsed = compile({ language: 'Solidity', sources: { 'DealArenaEscrow.sol': { content: source } }, settings: { outputSelection: { '*': { '': ['ast'], '*': ['abi'] } } } });
  const ast = parsed.sources['DealArenaEscrow.sol'].ast;
  const contract = ast.nodes.find((node) => node.nodeType === 'ContractDefinition' && node.name === 'DealArenaEscrow');
  const functions = contract.nodes.filter((node) => node.nodeType === 'FunctionDefinition' && node.kind === 'function');
  const byId = new Map(functions.map((node) => [node.id, node]));
  const byName = new Map(functions.map((node) => [node.name, node]));
  const textOf = (node) => { const [offset, size] = node.src.split(':').map(Number); return bytes.subarray(offset, offset + size).toString(); };
  const commonHead = source.slice(0, source.indexOf('contract DealArenaEscrow'));
  const declarations = contract.nodes.filter((node) => !['FunctionDefinition'].includes(node.nodeType));
  const prefix = (module) => declarations.map((node) => {
    let text = textOf(node).replace(/\bimmutable\s+/g, '');
    if (module && node.nodeType === 'VariableDeclaration') text = text.replace(/\bpublic\b/g, 'internal');
    // AST variable declarations exclude their terminating semicolon.
    if (node.nodeType === 'VariableDeclaration') text += ';';
    return text;
  }).join('\n');
  function closure(roots) {
    const selected = new Set();
    function add(node) {
      if (!node || selected.has(node.id)) return;
      selected.add(node.id);
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        if (byId.has(value.referencedDeclaration)) add(byId.get(value.referencedDeclaration));
        for (const entry of Object.values(value)) {
          if (Array.isArray(entry)) entry.forEach(visit);
          else if (entry && typeof entry === 'object') visit(entry);
        }
      };
      visit(node.body);
    }
    roots.forEach((name) => {
      if (!byName.has(name)) throw new Error(`Unknown module function: ${name}`);
      add(byName.get(name));
    });
    return functions.filter((node) => selected.has(node.id));
  }
  const routedNames = Object.values(GROUPS).flat();
  if (new Set(routedNames).size !== routedNames.length) throw new Error('Duplicate module route');
  const routerRoots = functions.filter((node) => node.visibility === 'external' && !routedNames.includes(node.name)).map((node) => node.name);
  const roots = new Set([...routerRoots, ...routedNames]);
  for (const node of functions) if (node.visibility === 'external' && !roots.has(node.name)) throw new Error(`Missing route: ${node.name}`);
  const constructor = textOf(contract.nodes.find((node) => node.kind === 'constructor'));
  const routerConstructor = constructor
    .replace('address _treasury)', 'address _treasury, address[] memory modules, bytes4[][] memory selectors)')
    .replace(/}\s*$/, `
      require(modules.length == selectors.length && modules.length == ${Object.keys(GROUPS).length}, "INVALID_MODULES");
      for (uint256 i = 0; i < modules.length; i++) {
        require(modules[i].code.length > 0, "MODULE_MISSING");
        for (uint256 j = 0; j < selectors[i].length; j++) {
          require(_routes[selectors[i][j]] == address(0), "DUPLICATE_ROUTE");
          _routes[selectors[i][j]] = modules[i];
        }
      }
    }`);
  const sources = {};
  sources['DealArenaRouter.sol'] = { content: `${commonHead}\ncontract DealArenaRouter {\n${prefix(false)}\nmapping(bytes4 => address) private _routes;\n${routerConstructor}\n${closure(routerRoots).map(textOf).join('\n')}\nfallback() external {\n address target = _routes[msg.sig];\n require(target != address(0), "UNKNOWN_ACTION");\n assembly {\n calldatacopy(0, 0, calldatasize())\n let success := delegatecall(gas(), target, 0, calldatasize(), 0, 0)\n returndatacopy(0, 0, returndatasize())\n switch success case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }\n }\n}\n}` };
  for (const [group, names] of Object.entries(GROUPS)) {
    const body = closure(names).map((node) => {
      const original = textOf(node);
      if (!names.includes(node.name)) return original;
      return original.replace(/\bexternal\b/, 'external onlyEscrow');
    }).join('\n');
    sources[`${group}.sol`] = { content: `${commonHead}\ncontract ${group} {\n${prefix(true)}\naddress private immutable _moduleSelf = address(this);\nmodifier onlyEscrow() { require(address(this) != _moduleSelf, "DIRECT_MODULE_CALL"); _; }\n${body}\n}` };
  }
  const settings = { evmVersion: 'paris', optimizer: { enabled: true, runs: 1 }, outputSelection: { '*': { '*': ['abi', 'storageLayout', 'evm.bytecode', 'evm.deployedBytecode'] } } };
  const output = compile({ language: 'Solidity', sources, settings });
  const router = output.contracts['DealArenaRouter.sol'].DealArenaRouter;
  const fullAbi = parsed.contracts['DealArenaEscrow.sol'].DealArenaEscrow.abi;
  const iface = new ethers.Interface(fullAbi);
  const moduleArtifacts = Object.entries(GROUPS).map(([name, names]) => {
    const module = output.contracts[`${name}.sol`][name];
    return { name, selectors: names.map((entry) => iface.getFunction(entry).selector), functions: names, abi: module.abi, bytecode: module.evm.bytecode.object, deployedBytecode: module.evm.deployedBytecode.object, runtimeBytes: module.evm.deployedBytecode.object.length / 2, storageLayout: module.storageLayout.storage };
  });
  for (const artifact of [{ name: 'DealArenaRouter', bytecode: router.evm.bytecode.object, runtimeBytes: router.evm.deployedBytecode.object.length / 2 }, ...moduleArtifacts]) {
    if (artifact.runtimeBytes > MAX_RUNTIME_BYTES || artifact.bytecode.length / 2 > MAX_INITCODE_BYTES) throw new Error(`${artifact.name} exceeds Tempo limits: runtime=${artifact.runtimeBytes}, init=${artifact.bytecode.length / 2}`);
  }
  const layout = (entries) => entries.map(({ label, slot, offset }) => ({ label, slot, offset }));
  const routerLayout = layout(router.storageLayout.storage.filter((entry) => entry.label !== '_routes'));
  for (const module of moduleArtifacts) if (JSON.stringify(layout(module.storageLayout)) !== JSON.stringify(routerLayout)) throw new Error(`Storage layout mismatch: ${module.name}`);
  const abi = fullAbi.filter((entry) => entry.type !== 'constructor');
  abi.unshift(router.abi.find((entry) => entry.type === 'constructor'));
  return { format: 'dealarena-fixed-modules-v1', contractVersion: 17, compiler: solc.version(), sourceHash: crypto.createHash('sha256').update(source).digest('hex'), settings, abi, bytecode: router.evm.bytecode.object, runtimeBytes: router.evm.deployedBytecode.object.length / 2, modules: moduleArtifacts, sources };
}

if (require.main === module) {
  const artifact = build();
  fs.writeFileSync(path.join(__dirname, 'compiled-v17.json'), JSON.stringify(artifact));
  fs.writeFileSync(path.join(__dirname, 'DealArenaEscrow-v17.json'), JSON.stringify({ abi: artifact.abi }, null, 2));
  console.log(`ROUTER_OK runtime=${artifact.runtimeBytes}, functions=${artifact.abi.filter((entry) => entry.type === 'function').length}`);
  for (const module of artifact.modules) console.log(`${module.name}: runtime=${module.runtimeBytes}, actions=${module.functions.length}`);
}

module.exports = { build, GROUPS, MAX_RUNTIME_BYTES, MAX_INITCODE_BYTES };
