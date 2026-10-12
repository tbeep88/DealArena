const EXPANSION_MARKER = /\n    \/\/ 2\. BUSINESS BULK PURCHASING POOLS[\s\S]*?\n    function getDealBuyers/;

function toCoreSource(source) {
  let core = source;
  core = core.replace(/\n    struct BusinessPool \{[\s\S]*?\n    \}\n\n    struct DemandRequest \{[\s\S]*?\n    \}\n/, '\n');
  core = core.replace(/\n    mapping\(string => BusinessPool\) public businessPools;[\s\S]*?\n    mapping\(string => uint256\) public refundTotals;\n/, '\n    mapping(string => uint256) public refundTotals;\n');
  core = core.replace(/\n    event BusinessPoolJoined\([\s\S]*?\n    event TreasuryUpdated/, '\n    event TreasuryUpdated');
  core = core.replace(EXPANSION_MARKER, '\n    function getDealBuyers');
  core = core.replace(/\n    function getRequestBuyers[\s\S]*?\n    function getDealState/, '\n    function getDealState');
  return core;
}

module.exports = { toCoreSource };
