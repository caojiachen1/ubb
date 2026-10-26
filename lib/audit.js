// In-memory operation audit ring.

class AuditRing {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }

  log(entry) {
    this.entries.push({ t: new Date().toISOString(), ...entry });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  list(limit = 100) {
    return this.entries.slice(-Math.min(limit, this.entries.length)).reverse();
  }
}

export const audit = new AuditRing();
