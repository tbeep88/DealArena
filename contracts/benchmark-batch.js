/**
 * Provisional model: outbound payout cost by recipient count.
 * This is not a live chain benchmark and must not be presented as measured gas.
 */

const { ethers } = require('ethers');

const BASE_TX_GAS = 21000n;
const TIP20_TRANSFER_GAS = 28500n; // Standard TIP-20 / PathUSD transferFrom/transfer cost
const CONTRACT_LOOP_OVERHEAD_PER_RECIPIENT = 5200n; // Storage write/clear, loop index increment, event emission
const TEMPO_BLOCK_GAS_LIMIT = 30000000n; // Tempo Moderato standard block gas ceiling

function calculateBatchGas(recipientCount) {
  const count = BigInt(recipientCount);
  const totalGas = BASE_TX_GAS + (count * (TIP20_TRANSFER_GAS + CONTRACT_LOOP_OVERHEAD_PER_RECIPIENT));
  const gasFractionOfBlock = (Number(totalGas) / Number(TEMPO_BLOCK_GAS_LIMIT)) * 100;
  return {
    recipientCount,
    totalGasEstimate: totalGas.toString(),
    gasPerRecipient: (TIP20_TRANSFER_GAS + CONTRACT_LOOP_OVERHEAD_PER_RECIPIENT).toString(),
    blockUtilizationPercent: gasFractionOfBlock.toFixed(2) + '%',
    safeWithinBlockLimit: totalGas < (TEMPO_BLOCK_GAS_LIMIT * 80n / 100n), // Safe threshold at 80% capacity
  };
}

function runBenchmark() {
  console.log('========================================================================');
  console.log('TEMPO BATCH SETTLEMENT & REFUND BENCHMARK ANALYSIS');
  console.log('Target Chain: Tempo Moderato (Chain ID: 42431)');
  console.log('Block Gas Limit: 30,000,000');
  console.log('========================================================================\n');

  const testScales = [1, 5, 10, 25, 50, 100, 150, 200, 500, 800];
  const results = testScales.map(calculateBatchGas);

  console.table(results);

  const theoreticalMax = (TEMPO_BLOCK_GAS_LIMIT - BASE_TX_GAS) / (TIP20_TRANSFER_GAS + CONTRACT_LOOP_OVERHEAD_PER_RECIPIENT);
  const recommendedBatch = (TEMPO_BLOCK_GAS_LIMIT * 25n / 100n) / (TIP20_TRANSFER_GAS + CONTRACT_LOOP_OVERHEAD_PER_RECIPIENT); // 25% block target for fast propagation

  console.log(`\n[Benchmark Summary]:`);
  console.log(`- Provisional model cost per recipient: ~33,700 gas (not measured on a live chain)`);
  console.log(`- Theoretical model ceiling: ${theoreticalMax} recipients (not a production limit)`);
  console.log(`- Provisional 25% block target: ~${recommendedBatch} recipients`);
  console.log(`- Production LIVE path is deliberately capped at 10 buyers and uses a Tempo Type 0x76 native batch.`);
  console.log('========================================================================\n');
}

async function probeLiveRpcBenchmark(provider, contractAddress, walletAddress) {
  try {
    const startMs = Date.now();
    const blockHex = await provider.send('eth_blockNumber', []);
    const block = await provider.send('eth_getBlockByNumber', [blockHex, false]);
    const gasPriceHex = await provider.send('eth_gasPrice', []);
    const rpcLatencyMs = Date.now() - startMs;
    const blockGasLimit = block && block.gasLimit ? parseInt(block.gasLimit, 16) : 30000000;
    const gasPriceWei = gasPriceHex ? parseInt(gasPriceHex, 16) : 1000000000;

    return {
      measuredAt: new Date().toISOString(),
      latestBlock: blockHex ? parseInt(blockHex, 16) : null,
      liveBlockGasLimit: blockGasLimit,
      liveGasPriceWei: gasPriceWei,
      rpcRoundtripMs: rpcLatencyMs,
      contractAddress,
      walletAddress,
    };
  } catch (err) {
    return { error: err.message };
  }
}

if (require.main === module) {
  runBenchmark();
}

module.exports = { calculateBatchGas, runBenchmark, probeLiveRpcBenchmark };
