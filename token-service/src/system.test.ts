import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCgroupV2Path, parseEtime, parseKeyValues, parseMeminfo, parseNetDev } from './system';

test('parseEtime reads every ps etime shape', () => {
  assert.equal(parseEtime('03:58'), 238);
  assert.equal(parseEtime('17:44:25'), 17 * 3600 + 44 * 60 + 25);
  assert.equal(parseEtime('2-01:00:05'), 2 * 86400 + 3600 + 5);
  assert.equal(parseEtime('garbage'), null);
});

test('parseNetDev picks the named interface, not a prefix match', () => {
  const text = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 9000 10 0 0 0 0 0 0 9000 10 0 0 0 0 0 0',
    '  eth0: 123456 900 0 0 0 0 0 0 654321 800 0 0 0 0 0 0',
    '  eth01: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0',
  ].join('\n');
  assert.deepEqual(parseNetDev(text, 'eth0'), { rx: 123456, tx: 654321 });
  assert.equal(parseNetDev(text, 'eth9'), null);
});

test('parseMeminfo converts kB to bytes', () => {
  const m = parseMeminfo('MemTotal:        4005060 kB\nMemAvailable:    2987424 kB\nHugePages_Total:       0\n');
  assert.equal(m.MemTotal, 4005060 * 1024);
  assert.equal(m.MemAvailable, 2987424 * 1024);
  assert.equal(m.HugePages_Total, undefined);
});

test('parseCgroupV2Path reads the unified (0::) hierarchy line', () => {
  assert.equal(
    parseCgroupV2Path('0::/system.slice/docker-8bdd29c3.scope\n'),
    '/sys/fs/cgroup/system.slice/docker-8bdd29c3.scope',
  );
  // cgroup v1 hosts list controllers instead; there's no unified path to read.
  assert.equal(parseCgroupV2Path('12:memory:/docker/8bdd\n11:cpu,cpuacct:/docker/8bdd\n'), null);
});

test('parseKeyValues reads cpu.stat / memory.stat and skips non-numeric lines', () => {
  const v = parseKeyValues('usage_usec 1090589513\nuser_usec 439485052\ninactive_file 4096\nweird line here\n');
  assert.equal(v.usage_usec, 1090589513);
  assert.equal(v.inactive_file, 4096);
  assert.equal(v.weird, undefined);
});
