'use strict';

const fs = require('fs');
const os = require('os');

/**
 * Containers see the host's RAM through os.totalmem(), which hides the real
 * cgroup limit (Render free = 512 MB). Reading the cgroup files is the only
 * way to know what the process may actually use.
 */
function memoryLimitMB() {
  const files = [
    '/sys/fs/cgroup/memory.max', // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
  ];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw || raw === 'max') continue;
      const bytes = Number(raw);
      // Ignore the "unlimited" sentinel some kernels use (~1 PB).
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 1024 ** 4) return Math.round(bytes / 1048576);
    } catch {
      /* not a cgroup path we can read */
    }
  }
  return Math.round(os.totalmem() / 1048576);
}

function cpuLimit() {
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)[0]);
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)[1]);
    if (Number.isFinite(quota) && Number.isFinite(period) && quota > 0) {
      return Math.round(((quota / period) * 100) / 100);
    }
  } catch {
    /* ignore */
  }
  return null;
}

module.exports = { memoryLimitMB, cpuLimit };