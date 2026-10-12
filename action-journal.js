'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
class ActionJournal {
  constructor(file) {
    this.file = file;
    this.records = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    this.running = new Map();
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const pending = `${this.file}.tmp`;
    fs.writeFileSync(pending, JSON.stringify(this.records), { mode: 0o600 });
    fs.renameSync(pending, this.file);
  }
  update(id, patch) {
    this.records[id] = { ...this.records[id], ...patch, updatedAt: new Date().toISOString() };
    this.save();
  }
  async run(id, payload, task) {
    if (typeof id !== 'string' || !/^[\w:-]{8,160}$/.test(id)) throw new Error('A valid actionId is required');
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
    const previous = this.records[id];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Action ID payload conflict');
      if (this.running.has(id)) return this.running.get(id);
      const retryableFailure = previous.status === 'FAILED' && !previous.hash && !previous.result?.hash;
      if (!retryableFailure) {
        return previous.result || { success: false, status: 'PENDING', hash: previous.hash || null, error: 'Action was already dispatched. Check its receipt; do not resend.' };
      }
      this.update(id, {
        status: 'RETRYING',
        result: null,
        hash: null,
        retryCount: Number(previous.retryCount || 0) + 1,
      });
    }
    this.update(id, { fingerprint, payload: canonical(payload), status: 'RESERVED', createdAt: new Date().toISOString() });
    const promise = (async () => {
      try {
        const result = await task((patch) => this.update(id, patch));
        this.update(id, { status: result.status, result });
        return result;
      } catch (err) {
        // Once dispatch has started, an error is not proof that no transaction exists.
        const entry = this.records[id];
        const status = err.txStatus || (entry.hash || entry.status === 'BROADCASTING' ? 'PENDING' : 'FAILED');
        const error = err.message || err.shortMessage || err.reason || String(err);
        const result = { success: false, isOnChain: false, status, hash: err.txHash || entry.hash || null, error,
          receipts: Array.isArray(err.partialReceipts) ? err.partialReceipts : [] };
        this.update(id, { status, result });
        return result;
      } finally { this.running.delete(id); }
    })();
    this.running.set(id, promise);
    return promise;
  }
}
module.exports = { ActionJournal };
