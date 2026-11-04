import assert from 'node:assert/strict';
import './testRecordingsEnv';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

process.env.SPACES_DB_FILE = ':memory:';
process.env.TOKEN_SERVICE_SHARED_SECRET = 'shared-secret-for-tests';
process.env.SPACES_PUBLIC_WEB_URL = 'https://spaces.test/';

import { getRegistry } from './apps';
import type { JoinTokenRequest } from './joinToken';
import {
  DEFAULT_DURATION_MS,
  EARLY_JOIN_MS,
  guardTokenRequest,
  guestState,
  HOUR_MS,
  MAX_DURATION_MS,
  newRoomName,
  randomSuffix,
} from './reservations';
import { reservationLookupRoutes, roomsApi, type RoomsDeps } from './roomsApi';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const keys: Record<string, string> = {};

function setup() {
  const calls = { minted: [] as JoinTokenRequest[], closed: [] as string[] };
  let now = NOW;
  const deps: RoomsDeps = {
    closeRoom: async (room) => {
      calls.closed.push(room);
      return true;
    },
    issueJoinToken: async (req) => {
      calls.minted.push(req);
      return { ok: true, details: { serverUrl: 'ws://lk', roomName: req.room, participantName: req.name, participantToken: 'tok.' + req.identity, callSettings: {} as never } };
    },
    publicWebUrl: () => 'https://spaces.test',
    now: () => now,
  };
  const app = Fastify();
  app.register(roomsApi(deps), { prefix: '/v1' });
  app.register(reservationLookupRoutes(deps));
  const registry = getRegistry();
  // One process-wide registry (requireApp reads it), and an app holds at most two keys: issue one per app.
  const key = (slug: string) => (keys[slug] ??= `Bearer ${registry.issueKey(slug).key}`);
  const call = async (method: 'GET' | 'POST', url: string, auth: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: { authorization: auth }, payload: payload as never });
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  return { app, deps, calls, registry, key, call, setNow: (t: number) => (now = t) };
}

test('room names are <slug>-<26 base32 characters> from 128 random bits', () => {
  assert.equal(randomSuffix(Buffer.alloc(16)), 'a'.repeat(26));
  assert.equal(randomSuffix(Buffer.alloc(16, 0xff)), '7'.repeat(25) + '4');
  assert.match(newRoomName('erp'), /^erp-[a-z2-7]{26}$/);
  const seen = new Set<string>();
  const symbols = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const s = randomSuffix();
    seen.add(s);
    for (const c of s) symbols.add(c);
  }
  assert.equal(seen.size, 2000);
  assert.equal(symbols.size, 32);
});

test('guest window: early until 15 min before start, open until expiry, then expired; ended wins', () => {
  const r = { startsAt: iso(NOW), expiresAt: iso(NOW + HOUR_MS), endedAt: null };
  assert.equal(guestState(r, NOW - EARLY_JOIN_MS - 1), 'early');
  assert.equal(guestState(r, NOW - EARLY_JOIN_MS), 'open');
  assert.equal(guestState(r, NOW + HOUR_MS - 1), 'open');
  assert.equal(guestState(r, NOW + HOUR_MS), 'expired');
  assert.equal(guestState({ ...r, endedAt: iso(NOW) }, NOW), 'ended');
});

test('create, get, join-tokens and end for the owning app', async () => {
  const t = setup();
  const erp = t.key('erp');
  const created = await t.call('POST', '/v1/rooms', erp, { title: 'Intro call', externalRef: 'activity-1', record: true, waitingRoom: true });
  assert.equal(created.status, 201);
  assert.match(created.body.roomName, /^erp-[a-z2-7]{26}$/);
  assert.equal(created.body.joinUrl, `https://spaces.test/rooms/${created.body.roomName}`);
  assert.equal(created.body.expiresAt, iso(NOW + DEFAULT_DURATION_MS));
  assert.deepEqual(Object.keys(created.body).sort(), ['expiresAt', 'joinUrl', 'roomId', 'roomName']);

  const got = await t.call('GET', `/v1/rooms/${created.body.roomId}`, erp);
  assert.equal(got.status, 200);
  assert.equal(got.body.title, 'Intro call');
  assert.equal(got.body.state, 'open');
  assert.equal(got.body.record, true);

  const host = await t.call('POST', `/v1/rooms/${created.body.roomId}/join-tokens`, erp, { identity: 'u1', name: 'Ann', host: true });
  assert.equal(host.status, 200);
  assert.equal(host.body.token, 'tok.u1');
  assert.equal(host.body.url, `${created.body.joinUrl}#t=tok.u1`);
  assert.deepEqual(t.calls.minted[0], { room: created.body.roomName, identity: 'u1', name: 'Ann', host: true, reserved: { record: true, waitingRoom: true } });

  const guest = await t.call('POST', `/v1/rooms/${created.body.roomId}/join-tokens`, erp, { identity: 'u2', name: 'Bob' });
  assert.equal(guest.status, 200);
  assert.equal(t.calls.minted[1].host, false);

  const ended = await t.call('POST', `/v1/rooms/${created.body.roomId}/end`, erp);
  assert.equal(ended.status, 200);
  assert.equal(ended.body.liveRoomClosed, true);
  assert.deepEqual(t.calls.closed, [created.body.roomName]);
  assert.equal((await t.call('GET', `/v1/rooms/${created.body.roomId}`, erp)).body.state, 'ended');
  assert.equal((await t.call('POST', `/v1/rooms/${created.body.roomId}/join-tokens`, erp, { identity: 'u1', name: 'Ann', host: true })).status, 410);

  const actions = t.registry.listAudit(20).map((e) => e.action);
  for (const a of ['room.create', 'host_token.mint', 'room.end']) assert.ok(actions.includes(a), a);
  assert.equal(actions.filter((a) => a === 'host_token.mint').length, 1, 'guest tokens are not audited');
  assert.equal(t.registry.listAudit(20).find((e) => e.action === 'room.create')!.externalRef, 'activity-1');
});

test('another app gets 404 for a room it does not own, like a missing one', async () => {
  const t = setup();
  const erp = t.key('erp');
  if (!t.registry.getApp('other')) t.registry.createApp({ slug: 'other', name: 'Other', scopes: ['rooms:create', 'rooms:end', 'rooms:read', 'tokens:mint'] });
  const other = t.key('other');
  const { body } = await t.call('POST', '/v1/rooms', erp, { title: 'T', externalRef: 'r' });
  const missing = await t.call('GET', '/v1/rooms/rm_000000000000000000000000', other);
  for (const [method, suffix] of [['GET', ''], ['POST', '/end'], ['POST', '/join-tokens']] as const) {
    const res = await t.call(method, `/v1/rooms/${body.roomId}${suffix}`, other, method === 'POST' ? { identity: 'x', name: 'X', host: true } : undefined);
    assert.equal(res.status, 404, suffix);
    assert.deepEqual(res.body, missing.body);
  }
  assert.equal(t.calls.minted.length + t.calls.closed.length, 0);
  assert.equal(t.registry.reservations.get(body.roomId)!.endedAt, null);
});

test('scopes are enforced: 403 without them, 401 without a credential; /apps/me takes any valid one', async () => {
  const t = setup();
  const web = t.key('spaces-web'); // no rooms:create: the call website can never reserve a room
  assert.equal((await t.call('POST', '/v1/rooms', web, { title: 'T', externalRef: 'r' })).status, 403);
  // It has rooms:read and rooms:end for the call UI, but owns no reservation: same 404 as a missing room.
  assert.equal((await t.call('GET', '/v1/rooms/rm_x', web)).status, 404);
  assert.equal((await t.call('POST', '/v1/rooms/rm_x/end', web)).status, 404);
  assert.equal((await t.call('POST', '/v1/rooms', 'Bearer nope', { title: 'T', externalRef: 'r' })).status, 401);
  assert.equal((await t.call('GET', '/v1/apps/me', 'Bearer nope')).status, 401);
  const me = await t.call('GET', '/v1/apps/me', web);
  assert.deepEqual(me.body, { slug: 'spaces-web', name: 'Spaces web (demo)', scopes: ['rooms:end', 'rooms:read', 'tokens:mint', 'recordings:control'] });
});

test('create validates input and the expiry window', async () => {
  const t = setup();
  const erp = t.key('erp');
  const bad = async (payload: unknown) => (await t.call('POST', '/v1/rooms', erp, payload)).status;
  assert.equal(await bad({ externalRef: 'r' }), 400);
  assert.equal(await bad({ title: 'T' }), 400);
  assert.equal(await bad({ title: 'T', externalRef: 'r', startsAt: 'tomorrow' }), 400);
  assert.equal(await bad({ title: 'T', externalRef: 'r', record: 'yes' }), 400);
  assert.equal(await bad({ title: 'T', externalRef: 'r', expiresAt: iso(NOW - 1) }), 400);
  assert.equal(await bad({ title: 'T', externalRef: 'r', startsAt: iso(NOW + HOUR_MS), expiresAt: iso(NOW + HOUR_MS) }), 400);
  assert.equal(await bad({ title: 'T', externalRef: 'r', expiresAt: iso(NOW + MAX_DURATION_MS + 1) }), 400);
  assert.equal(await bad({ title: 'T', externalRef: 'r', expiresAt: iso(NOW + MAX_DURATION_MS) }), 201);
  const later = await t.call('POST', '/v1/rooms', erp, { title: 'T', externalRef: 'r', startsAt: iso(NOW + 24 * HOUR_MS) });
  assert.equal(later.body.expiresAt, iso(NOW + 24 * HOUR_MS + DEFAULT_DURATION_MS), 'default is start + 12 h');
});

test('lookup: reservation state for the demo; implicit and unknown rooms are unreserved', async () => {
  const t = setup();
  const erp = t.key('erp');
  const secret = 'Bearer shared-secret-for-tests';
  const { body } = await t.call('POST', '/v1/rooms', erp, { title: 'T', externalRef: 'r', startsAt: iso(NOW + HOUR_MS), expiresAt: iso(NOW + 2 * HOUR_MS) });
  const look = (room: string, auth = secret) => t.call('GET', `/room/reservation?room=${room}`, auth);
  assert.deepEqual((await look(body.roomName)).body, { reserved: true, state: 'early', startsAt: iso(NOW + HOUR_MS), expiresAt: iso(NOW + 2 * HOUR_MS) });
  t.setNow(NOW + HOUR_MS - EARLY_JOIN_MS);
  assert.equal((await look(body.roomName)).body.state, 'open');
  t.setNow(NOW + 2 * HOUR_MS);
  assert.equal((await look(body.roomName)).body.state, 'expired');
  assert.deepEqual((await look('lobby-room')).body, { reserved: false });
  t.registry.reservations.recordImplicit(t.registry.getApp('petition-studio')!.id, 'case-1');
  assert.deepEqual((await look('case-1')).body, { reserved: false });
  assert.equal((await look('x', 'Bearer wrong')).status, 401);
});

test('/token bookkeeping: implicit reservation is kept once, never replaces a real one', () => {
  const t = setup();
  const ps = t.registry.getApp('petition-studio')!.id;
  const store = t.registry.reservations;
  store.recordImplicit(ps, 'case-42', NOW);
  assert.equal(store.getByRoom('case-42')!.expiresAt, iso(NOW + DEFAULT_DURATION_MS));
  store.recordImplicit(ps, 'case-42', NOW + 1000); // every mint keeps its own implicit reservation active
  const r = store.getByRoom('case-42')!;
  assert.equal(r.appId, ps);
  assert.equal(r.implicit, true);
  assert.equal(r.startsAt, iso(NOW));
  assert.equal(r.expiresAt, iso(NOW + 1000 + DEFAULT_DURATION_MS));
  const real = store.create(t.registry.getApp('erp')!.id, 'erp', { title: 'T', externalRef: 'r' }, NOW);
  store.recordImplicit(ps, real.roomName, NOW);
  assert.equal(store.getByRoom(real.roomName)!.appId, real.appId);
  assert.equal(store.getByRoom(real.roomName)!.implicit, false);
});

test('token guard: a guest is never promoted, and other apps get no host token or late guest token', () => {
  const t = setup();
  const erpId = t.registry.getApp('erp')!.id;
  const psId = t.registry.getApp('petition-studio')!.id;
  const r = t.registry.reservations.create(erpId, 'erp', { title: 'T', externalRef: 'r', startsAt: iso(NOW), expiresAt: iso(NOW + HOUR_MS) }, NOW);
  assert.deepEqual(guardTokenRequest(null, psId, true, NOW), { ok: true });
  assert.deepEqual(guardTokenRequest(r, erpId, true, NOW + 10 * HOUR_MS), { ok: true }, 'the owner is never blocked');
  assert.equal(guardTokenRequest(r, psId, true, NOW).ok, false, 'host token for another app room');
  assert.deepEqual(guardTokenRequest(r, psId, false, NOW), { ok: true });
  const late = guardTokenRequest(r, psId, false, NOW + HOUR_MS);
  assert.ok(!late.ok && late.status === 403 && late.reservation === 'expired');
  const early = guardTokenRequest(r, psId, false, NOW - EARLY_JOIN_MS - 1);
  assert.ok(!early.ok && early.reservation === 'early');
  t.registry.reservations.end(r.id, NOW);
  const ended = guardTokenRequest(t.registry.reservations.get(r.id), psId, false, NOW);
  assert.ok(!ended.ok && ended.reservation === 'ended');
  t.registry.reservations.recordImplicit(psId, 'case-9', NOW);
  assert.equal(guardTokenRequest(t.registry.reservations.getByRoom('case-9'), erpId, false, NOW + 99 * HOUR_MS).ok, true, 'implicit windows are not enforced');
  assert.equal(guardTokenRequest(t.registry.reservations.getByRoom('case-9'), erpId, true, NOW).ok, false);
});

// --- guest-first joins seed the room from the reservation ---

process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'secret';
process.env.LIVEKIT_URL = 'ws://localhost:7880';

import { issueJoinToken, type LiveKitOps } from './joinToken';
import { mintToken, parseRoomSettings } from './livekit';

/** An in-memory LiveKit: rooms with metadata, the real token minting. */
function fakeLiveKit() {
  const rooms = new Map<string, string>();
  const ensured: string[] = [];
  const settings = (room: string) => (rooms.has(room) ? parseRoomSettings(rooms.get(room)) : null);
  const ops: LiveKitOps = {
    capacityFor: async () => 'ok',
    getRoomSettings: async (room) => settings(room),
    ensureRoom: async (room, s = {}) => {
      ensured.push(room);
      if (!rooms.has(room)) rooms.set(room, JSON.stringify({ hosts: [], waitingRoom: false, record: false, spotlight: null, ...s }));
    },
    recordRoomHost: async (room, identity, waitingRoom) => {
      const cur = settings(room) ?? { hosts: [], waitingRoom: false, spotlight: null, record: false };
      rooms.set(room, JSON.stringify({ ...cur, hosts: [...new Set([...cur.hosts, identity])], waitingRoom: waitingRoom ?? cur.waitingRoom }));
    },
    markRoomRecorded: async (room) => {
      rooms.set(room, JSON.stringify({ ...(settings(room) ?? { hosts: [], waitingRoom: false, spotlight: null }), record: true }));
    },
    mintToken,
  };
  return { rooms, ensured, settings, ops };
}
const seedOf = (token: string) => JSON.parse(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).roomConfig.metadata);

test('a guest token for a record:true reservation carries the record seed, and the room is marked', async () => {
  const lk = fakeLiveKit();
  const res = await issueJoinToken({ room: 'erp-a', identity: 'g', name: 'G', host: false, reserved: { record: true, waitingRoom: false } }, lk.ops);
  assert.ok(res.ok);
  assert.deepEqual(seedOf(res.details.participantToken), { hosts: [], waitingRoom: false, spotlight: null, record: true });
  assert.equal(lk.settings('erp-a')!.record, true);
});

test('a guest token for a waitingRoom reservation carries it, and a guest who arrives first waits', async () => {
  const lk = fakeLiveKit();
  const reserved = { record: false, waitingRoom: true };
  const first = await issueJoinToken({ room: 'erp-b', identity: 'g', name: 'G', host: false, reserved }, lk.ops);
  assert.ok(!first.ok && first.status === 409 && first.body.waitingRoom === true, 'held in the waiting room');
  assert.equal(lk.settings('erp-b')!.waitingRoom, true);
  // Once admitted (or when the room has died and the token recreates it) the seed still says so.
  const seeded = await mintToken({ room: 'erp-b', identity: 'g', name: 'G', host: false, waitingRoom: true });
  assert.equal(seedOf(seeded.participantToken).waitingRoom, true);
});

test('a host mint after a guest keeps record and waitingRoom and adds the host', async () => {
  const lk = fakeLiveKit();
  const reserved = { record: true, waitingRoom: true };
  await issueJoinToken({ room: 'erp-c', identity: 'g', name: 'G', host: false, reserved }, lk.ops);
  const host = await issueJoinToken({ room: 'erp-c', identity: 'h', name: 'H', host: true, reserved }, lk.ops);
  assert.ok(host.ok);
  assert.deepEqual(lk.settings('erp-c'), { hosts: ['h'], waitingRoom: true, spotlight: null, record: true });
  assert.deepEqual(seedOf(host.details.participantToken), { hosts: ['h'], waitingRoom: true, spotlight: null, record: true });
});

test('a token for an unreserved room still ensures the room, with default settings', async () => {
  const lk = fakeLiveKit();
  const res = await issueJoinToken({ room: 'lobby-x', identity: 'g', name: 'G', host: false }, lk.ops);
  assert.ok(res.ok);
  assert.deepEqual(lk.ensured, ['lobby-x']);
  assert.deepEqual(lk.settings('lobby-x'), { hosts: [], waitingRoom: false, spotlight: null, record: false });
  assert.equal(JSON.parse(Buffer.from(res.details.participantToken.split('.')[1], 'base64url').toString()).roomConfig, undefined);
});

// --- only registered apps create rooms (ERP-72) ---

import { gateRoomRevival, gateTokenMint } from './reservations';
import { tokenRoute } from './tokenRoute';

function tokenSetup() {
  const lk = fakeLiveKit();
  let now = NOW;
  const t = setup();
  const app = Fastify();
  app.register(tokenRoute({ issueJoinToken: (req) => issueJoinToken(req, lk.ops), now: () => now }));
  app.register(roomsApi({ ...t.deps, issueJoinToken: (req) => issueJoinToken(req, lk.ops), now: () => now }), { prefix: '/v1' });
  const secret = 'Bearer shared-secret-for-tests';
  const mint = async (auth: string, room: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: 'POST', url: '/token', headers: { authorization: auth }, payload: { room, identity: 'g1', name: 'Guest', ...extra } });
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  const refused = (...rooms: string[]) => t.registry.listAudit(200).filter((e) => e.action === 'room.refused' && (rooms.length === 0 || rooms.includes(e.room ?? '')));
  return { lk, t, app, secret, mint, refused, setNow: (n: number) => (now = n) };
}

test('/token: an app without rooms:create (spaces-web, erp) is refused for an unreserved room, and audited', async () => {
  const { lk, t, mint, refused } = tokenSetup();
  for (const slug of ['spaces-web', 'erp']) {
    const res = await mint(t.key(slug), 'made-up-room');
    assert.equal(res.status, 404, slug);
    assert.equal(res.body.code, 'room_not_reserved');
    assert.match(res.body.error, /no longer active/);
    // host tokens too: nobody starts a room by claiming to host it
    assert.equal((await mint(t.key(slug), 'made-up-room', { host: true })).status, 404, `${slug} host`);
  }
  assert.equal(lk.rooms.size, 0, 'no LiveKit room was created');
  assert.equal(lk.ensured.length, 0);
  assert.equal(refused('made-up-room').length, 4);
  assert.deepEqual([...new Set(refused('made-up-room').map((e) => e.appSlug))].sort(), ['erp', 'spaces-web']);
});

test('/token: petition-studio (shared secret, rooms:create) still creates the room and leaves an implicit reservation', async () => {
  const { lk, t, mint, secret, refused } = tokenSetup();
  const res = await mint(secret, 'case-77-intake', { host: true });
  assert.equal(res.status, 200);
  assert.deepEqual(lk.ensured, ['case-77-intake']);
  assert.deepEqual(lk.settings('case-77-intake')!.hosts, ['g1']);
  const implicit = t.registry.reservations.getByRoom('case-77-intake')!;
  assert.equal(implicit.implicit, true);
  assert.equal(refused('case-77-intake').length, 0);
  // ...and now the call website can let a guest into that room while PS keeps it active
  assert.equal((await mint(t.key('spaces-web'), 'case-77-intake', { identity: 'g2' })).status, 200);
});

test('/token: a reserved room inside its window mints for spaces-web and creates the LiveKit room', async () => {
  const { lk, t, mint } = tokenSetup();
  const r = t.registry.reservations.create(t.registry.getApp('erp')!.id, 'erp', { title: 'T', externalRef: 'r', startsAt: iso(NOW), expiresAt: iso(NOW + HOUR_MS), record: true }, NOW);
  const res = await mint(t.key('spaces-web'), r.roomName);
  assert.equal(res.status, 200);
  assert.deepEqual(lk.ensured, [r.roomName]);
  assert.equal(lk.settings(r.roomName)!.record, true, 'created with the reservation\'s settings');
  // erp itself, calling /token for its own room as a guest, is held to the same window
  assert.equal((await mint(t.key('erp'), r.roomName, { identity: 'g3' })).status, 200);
});

test('/token: outside the guest window an app without rooms:create is refused and nothing is created', async () => {
  const { lk, t, mint, refused, setNow } = tokenSetup();
  const r = t.registry.reservations.create(t.registry.getApp('erp')!.id, 'erp', { title: 'T', externalRef: 'r', startsAt: iso(NOW + HOUR_MS), expiresAt: iso(NOW + 2 * HOUR_MS) }, NOW);
  const early = await mint(t.key('spaces-web'), r.roomName);
  assert.equal(early.status, 403);
  assert.equal(early.body.reservation, 'early');
  assert.equal((await mint(t.key('erp'), r.roomName)).status, 403, 'the owner as a guest too');
  assert.equal((await mint(t.key('erp'), r.roomName, { host: true })).status, 200, 'the owner\'s host may arrive early, as through join-tokens');
  lk.rooms.clear();
  lk.ensured.length = 0;
  setNow(NOW + 2 * HOUR_MS);
  const late = await mint(t.key('spaces-web'), r.roomName);
  assert.equal(late.status, 403);
  assert.equal(late.body.reservation, 'expired');
  assert.equal(lk.ensured.length, 0);
  assert.ok(refused(r.roomName).length >= 2, 'the refusals are audited');
  // ended reservation
  const ended = t.registry.reservations.create(t.registry.getApp('erp')!.id, 'erp', { title: 'T', externalRef: 'r2' }, NOW + 2 * HOUR_MS);
  t.registry.reservations.end(ended.id, NOW + 2 * HOUR_MS);
  assert.equal((await mint(t.key('spaces-web'), ended.roomName)).status, 403);
});

test('/token: a lapsed implicit reservation no longer lets the call website create the room', async () => {
  const { lk, t, mint, secret, setNow } = tokenSetup();
  await mint(secret, 'case-5');
  lk.rooms.clear();
  setNow(NOW + 13 * HOUR_MS);
  const res = await mint(t.key('spaces-web'), 'case-5');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'room_not_reserved');
  assert.equal((await mint(secret, 'case-5')).status, 200, 'Petition Studio keeps creating it, which makes it active again');
  assert.equal((await mint(t.key('spaces-web'), 'case-5')).status, 200);
});

test('join-tokens ensures the LiveKit room before handing out the token', async () => {
  const { lk, t, app } = tokenSetup();
  const erp = t.key('erp');
  const created = await t.call('POST', '/v1/rooms', erp, { title: 'T', externalRef: 'r', record: true, waitingRoom: true });
  assert.equal(lk.rooms.size, 0, 'creating the reservation creates no LiveKit room');
  const res = await app.inject({ method: 'POST', url: `/v1/rooms/${created.body.roomId}/join-tokens`, headers: { authorization: erp }, payload: { identity: 'h', name: 'Host', host: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(lk.ensured, [created.body.roomName]);
  assert.deepEqual(lk.settings(created.body.roomName), { hosts: ['h'], waitingRoom: true, spotlight: null, record: true });
});

test('revival gate for embed sessions: unreserved and lapsed implicit rooms are refused, explicit and active implicit are not', () => {
  const t = setup();
  const erpId = t.registry.getApp('erp')!.id;
  const psId = t.registry.getApp('petition-studio')!.id;
  assert.equal(gateRoomRevival(null, NOW).ok, false);
  const explicit = t.registry.reservations.create(erpId, 'erp', { title: 'T', externalRef: 'r', startsAt: iso(NOW + HOUR_MS), expiresAt: iso(NOW + 2 * HOUR_MS) }, NOW);
  assert.equal(gateRoomRevival(explicit, NOW).ok, true, 'a host token minted early is honoured');
  t.registry.reservations.recordImplicit(psId, 'case-8', NOW);
  const implicit = t.registry.reservations.getByRoom('case-8')!;
  assert.equal(gateRoomRevival(implicit, NOW + HOUR_MS).ok, true);
  const lapsed = gateRoomRevival(implicit, NOW + 13 * HOUR_MS);
  assert.ok(!lapsed.ok && lapsed.status === 404 && lapsed.code === 'room_not_reserved');
  assert.equal(gateTokenMint(explicit, false, NOW).ok, false);
});

test('ERP-86: owner lists recordings with transcripts only when ready, streams audio with ranges, others get 404', async () => {
  const t = setup();
  const erp = t.key('erp');
  if (!t.registry.getApp('other-rec')) t.registry.createApp({ slug: 'other-rec', name: 'Other', scopes: ['rooms:read', 'recordings:read'] });
  const other = t.key('other-rec');
  const mine = (await t.call('POST', '/v1/rooms', erp, { title: 'Mine', externalRef: 'rec-1' })).body;
  const theirs = (await t.call('POST', '/v1/rooms', erp, { title: 'Theirs', externalRef: 'rec-2' })).body;
  const compressed = process.env.EGRESS_COMPRESSED_DIR!;
  const transcripts = process.env.EGRESS_TRANSCRIPTS_DIR!;
  fs.mkdirSync(compressed, { recursive: true });
  fs.mkdirSync(transcripts, { recursive: true });
  const first = `${mine.roomName}-1793700000000.ogg`;
  const second = `${mine.roomName}-1793703600000.ogg`;
  const foreign = `${theirs.roomName}-1793700000000.ogg`;
  const bytes = Buffer.from('0123456789');
  for (const f of [first, second, foreign]) fs.writeFileSync(path.join(compressed, f), bytes);
  fs.writeFileSync(
    path.join(transcripts, `${first}.json`),
    JSON.stringify({
      file: first, room: mine.roomName, recordedAt: null, model: 'm', transcribedAt: 'x', durationMs: 123000, languages: ['en'], text: 'hello',
      segments: [{ speaker: '1', language: 'en', startMs: 0, endMs: 900, text: 'hello' }],
    }),
  );

  const list = await t.call('GET', `/v1/rooms/${mine.roomId}/recordings`, erp);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.recordings.map((r: any) => r.file), [first, second], 'oldest first, own room only');
  assert.equal(list.body.recordings[0].recordedAt, new Date(1793700000000).toISOString());
  assert.equal(list.body.recordings[0].durationMs, 123000);
  assert.equal(list.body.recordings[0].bytes, 10);
  assert.deepEqual(list.body.recordings[0].transcript, {
    status: 'ready', languages: ['en'], text: 'hello', segments: [{ speaker: '1', language: 'en', startMs: 0, endMs: 900, text: 'hello' }],
  });
  assert.deepEqual(list.body.recordings[1].transcript, { status: 'off' });
  assert.equal(list.body.recordings[1].durationMs, null);

  const url = `/v1/rooms/${mine.roomId}/recordings/${first}`;
  const raw = (headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers: { authorization: erp, ...headers } });
  const whole = await raw();
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['content-type'], 'audio/ogg');
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.rawPayload.toString(), '0123456789');
  const part = await raw({ range: 'bytes=2-4' });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 2-4/10');
  assert.equal(part.rawPayload.toString(), '234');
  const suffix = await raw({ range: 'bytes=-3' });
  assert.equal(suffix.headers['content-range'], 'bytes 7-9/10');
  const open = await raw({ range: 'bytes=0-' });
  assert.equal(open.statusCode, 206);
  assert.equal(open.headers['content-range'], 'bytes 0-9/10');
  const bad = await raw({ range: 'bytes=10-20' });
  assert.equal(bad.statusCode, 416);
  assert.equal(bad.headers['content-range'], 'bytes */10');

  // Only requests that start a playback are audited, not seeks.
  const audio = t.registry.listAudit(200).filter((e) => e.action === 'recording.audio' && e.room === mine.roomName);
  assert.equal(audio.length, 2, 'whole, bytes=0-, and nothing for the mid-file ranges');
  assert.ok(t.registry.listAudit(200).some((e) => e.action === 'recording.read'));

  // Another app, another room's file, an unknown file and an unsafe name all look like a missing room/file.
  for (const u of [`/v1/rooms/${mine.roomId}/recordings`, url]) assert.equal((await t.call('GET', u, other)).status, 404, u);
  assert.equal((await t.call('GET', `/v1/rooms/${mine.roomId}/recordings/${foreign}`, erp)).status, 404);
  assert.equal((await t.call('GET', `/v1/rooms/${mine.roomId}/recordings/${mine.roomName}-1793799999999.ogg`, erp)).status, 404);
  assert.equal((await t.call('GET', `/v1/rooms/${mine.roomId}/recordings/..%2Fx.ogg`, erp)).status, 404);
  // The web app lacks recordings:read.
  assert.equal((await t.call('GET', `/v1/rooms/${mine.roomId}/recordings`, t.key('spaces-web'))).status, 403);
});
