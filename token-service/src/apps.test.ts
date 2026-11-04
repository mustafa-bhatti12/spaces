import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AppRegistry, generateKey, hashSecret, MAX_ACTIVE_KEYS, parseKey, RegistryError, verifySecret } from './apps';

const fresh = () => new AppRegistry(':memory:');

test('generated keys parse back and hash to what is stored', () => {
  const { keyId, key, hash } = generateKey();
  assert.match(key, /^hsk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  const parsed = parseKey(key)!;
  assert.equal(parsed.keyId, keyId);
  assert.equal(hashSecret(parsed.secret), hash);
  assert.ok(verifySecret(parsed.secret, hash));
  assert.ok(!verifySecret(parsed.secret + 'x', hash));
});

test('parseKey rejects malformed keys', () => {
  for (const bad of ['', 'hsk_', 'hsk_abc_def', 'sk_0123456789ab_' + 'a'.repeat(43), 'hsk_0123456789ab_' + 'a'.repeat(42), 'hsk_0123456789AB_' + 'a'.repeat(43), 'hsk_0123456789ab_' + 'a'.repeat(43) + '!']) {
    assert.equal(parseKey(bad), null, bad);
  }
});

test('first start seeds the known apps and no keys', () => {
  const r = fresh();
  const apps = r.listApps();
  assert.deepEqual(apps.map((a) => a.slug), ['erp', 'petition-studio', 'spaces-web']);
  assert.deepEqual(r.getApp('erp')!.scopes, ['rooms:create', 'rooms:end', 'rooms:read', 'tokens:mint', 'recordings:control', 'recordings:read']);
  assert.deepEqual(r.getApp('petition-studio')!.scopes, ['rooms:create', 'tokens:mint', 'recordings:read']);
  assert.deepEqual(r.getApp('spaces-web')!.scopes, ['rooms:end', 'rooms:read', 'tokens:mint', 'recordings:control']);
  assert.ok(!r.getApp('spaces-web')!.scopes.includes('rooms:create'));
  assert.ok(apps.every((a) => a.activeKeys === 0));
});

test('seeding twice keeps existing rows', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-')), 'db.sqlite');
  const a = new AppRegistry(file);
  a.createApp({ slug: 'extra', name: 'Extra', scopes: ['rooms:read'] });
  a.close();
  const b = new AppRegistry(file);
  assert.equal(b.listApps().length, 4);
  b.close();
});

test('stores only the hash of an issued key, and authenticates it', () => {
  const r = fresh();
  const { keyId, key } = r.issueKey('erp');
  const dump = JSON.stringify(r.listApps());
  assert.ok(!dump.includes(parseKey(key)!.secret));
  const found = r.authenticateKey(key);
  assert.ok(found !== 'invalid' && found.app.slug === 'erp' && found.keyId === keyId);
  assert.equal(r.authenticateKey(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')), 'invalid');
  assert.equal(r.authenticateKey('hsk_000000000000_' + 'a'.repeat(43)), 'invalid');
  assert.ok(r.listApps().find((a) => a.slug === 'erp')!.lastUsedAt);
});

test('a revoked key no longer authenticates, and frees a slot', () => {
  const r = fresh();
  const first = r.issueKey('erp');
  r.issueKey('erp');
  assert.equal(r.listApps()[0].activeKeys, MAX_ACTIVE_KEYS);
  assert.throws(() => r.issueKey('erp'), (e) => e instanceof RegistryError && e.status === 409);
  r.revokeKey('erp', first.keyId);
  assert.equal(r.authenticateKey(first.key), 'invalid');
  assert.equal(r.listApps()[0].activeKeys, 1);
  assert.throws(() => r.revokeKey('erp', first.keyId), (e) => e instanceof RegistryError && e.status === 404);
  r.issueKey('erp');
});

test('createApp validates input and rejects duplicates', () => {
  const r = fresh();
  const bad = [
    { slug: 'Bad Slug', name: 'x', scopes: ['rooms:read'] },
    { slug: 'ok-app', name: '', scopes: ['rooms:read'] },
    { slug: 'ok-app', name: 'x', scopes: [] },
    { slug: 'ok-app', name: 'x', scopes: ['rooms:delete'] },
  ];
  for (const b of bad) assert.throws(() => r.createApp(b), (e) => e instanceof RegistryError && e.status === 400);
  assert.equal(r.createApp({ slug: 'ok-app', name: 'OK', scopes: ['rooms:read', 'rooms:read'] }).scopes.length, 1);
  assert.throws(() => r.createApp({ slug: 'erp', name: 'x', scopes: ['rooms:read'] }), (e) => e instanceof RegistryError && e.status === 409);
});

test('audit writer appends events newest first and pages', () => {
  const r = fresh();
  r.audit({ actor: 'admin', appSlug: 'erp', action: 'app.create', result: 'ok' });
  r.audit({ actor: 'app', appSlug: 'erp', keyId: 'k1', action: 'host_token.mint', room: 'r1', ip: '1.2.3.4', result: 'ok', detail: 'd' });
  r.audit({ actor: 'app', appSlug: 'nope', action: 'room.end', result: 'denied' });
  const events = r.listAudit();
  assert.deepEqual(events.map((e) => e.action), ['room.end', 'host_token.mint', 'app.create']);
  assert.equal(events[1].room, 'r1');
  assert.equal(events[1].ip, '1.2.3.4');
  assert.equal(events[1].appId, r.getApp('erp')!.id);
  assert.equal(events[0].appId, null);
  assert.deepEqual(r.listAudit(10, events[0].id).map((e) => e.action), ['host_token.mint', 'app.create']);
  assert.equal(r.listAudit(1).length, 1);
});

test('backup writes a copy and keeps only the newest files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-bak-'));
  const r = fresh();
  for (const day of ['01', '02', '03']) r.backup(dir, 2, new Date(`2026-11-${day}T00:00:00Z`));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['spaces-2026-11-02.db', 'spaces-2026-11-03.db']);
  const copy = new AppRegistry(path.join(dir, 'spaces-2026-11-03.db'));
  assert.equal(copy.listApps().length, 3);
  copy.close();
});

test('an existing database gets the spaces-web scopes once, and keeps its keys', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-')), 'db.sqlite');
  const a = new AppRegistry(file);
  const { key } = a.issueKey('spaces-web');
  a.close();
  // Rewind to how a pre-ERP-72 database looks: spaces-web with only tokens:mint, erp without recordings:control.
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE app SET scopes = '["tokens:mint"]' WHERE slug = 'spaces-web'`);
  raw.exec(`UPDATE app SET scopes = '["rooms:create","rooms:end","rooms:read","tokens:mint"]' WHERE slug = 'erp'`);
  raw.exec('PRAGMA user_version = 2');
  raw.close();
  const b = new AppRegistry(file);
  assert.deepEqual(b.getApp('spaces-web')!.scopes, ['rooms:end', 'rooms:read', 'tokens:mint', 'recordings:control']);
  assert.deepEqual(b.getApp('erp')!.scopes, ['rooms:create', 'rooms:end', 'rooms:read', 'tokens:mint', 'recordings:control', 'recordings:read']);
  const found = b.authenticateKey(key);
  assert.ok(found !== 'invalid' && found.app.slug === 'spaces-web');
  // The step ran once: a later hand edit in /admin-less SQL survives a restart.
  b.close();
  const raw2 = new DatabaseSync(file);
  raw2.exec(`UPDATE app SET scopes = '["tokens:mint"]' WHERE slug = 'spaces-web'`);
  raw2.close();
  const c = new AppRegistry(file);
  assert.deepEqual(c.getApp('spaces-web')!.scopes, ['tokens:mint']);
  c.close();
});

test('ERP-86 migration adds recordings:read to erp and keeps its other scopes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-')), 'db.sqlite');
  new AppRegistry(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE app SET scopes = '["rooms:create","rooms:end","rooms:read","tokens:mint","recordings:control"]' WHERE slug = 'erp'`);
  raw.exec('PRAGMA user_version = 3');
  raw.close();
  const r = new AppRegistry(file);
  assert.deepEqual(r.getApp('erp')!.scopes, ['rooms:create', 'rooms:end', 'rooms:read', 'tokens:mint', 'recordings:control', 'recordings:read']);
  assert.deepEqual(r.getApp('petition-studio')!.scopes, ['rooms:create', 'tokens:mint', 'recordings:read']);
  r.close();
});
