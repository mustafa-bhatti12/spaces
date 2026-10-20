import { Track, type Room } from 'livekit-client';

/** One `stats` call-log event: this browser's view of its media over the last sample window. */
export interface CallStats {
  /** Selected candidate pair's current round-trip time to the SFU (or TURN relay). */
  rttMs: number | null;
  /** Local candidate of the selected pair: direct UDP/TCP, or relayed through TURN over UDP/TCP/TLS. */
  path: 'udp' | 'tcp' | 'relay-udp' | 'relay-tcp' | 'relay-tls' | null;
  upAudioKbps: number | null;
  upVideoKbps: number | null;
  /** The browser's bandwidth estimate for sending. */
  availOutKbps: number | null;
  downAudioKbps: number | null;
  downVideoKbps: number | null;
  /** Packets lost of everything we hear, over the window. */
  audioLossPct: number | null;
  /** Worst jitter among the audio we hear. */
  audioJitterMs: number | null;
  /** Share of played-out audio that was made up (silence/robot voice) because packets were missing. */
  concealedPct: number | null;
  /** What the SFU loses of our mic (its receiver report). */
  remoteLossPct: number | null;
}

/** Cumulative counters per RTP stream id, kept to turn the next sample into deltas. */
interface Counters {
  at: number;
  /** The transports these ids belong to; a new one (rejoin, full reconnect) restarts the ids. */
  source: object;
  out: Map<string, { kind: string; bytes: number }>;
  in: Map<string, { kind: string; bytes: number; lost: number; received: number; concealed: number; samples: number }>;
}

type Stat = Record<string, unknown> & { id: string; type: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: number | null) => (v === null ? null : Math.round(v));
const pct = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * The room's RTCPeerConnections, through LiveKit internals (`room.engine.pcManager`, typed in
 * livekit-client's `dist/src/room/RTCEngine.d.ts`). With `singlePeerConnection` (2.22's default,
 * protocol 17) there is only the publisher transport; older servers give a subscriber too.
 */
function transports(room: Room) {
  const pcm = room.engine?.pcManager;
  if (!pcm) return null;
  return { source: pcm as object, list: [pcm.publisher, pcm.subscriber].filter((t) => t !== undefined) };
}

/** The candidate pair ICE is using: Chrome/Safari name it on the transport, Firefox flags it `selected`. */
function selectedPair(stats: Map<string, Stat>): Stat | undefined {
  for (const s of stats.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      const pair = stats.get(s.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  let nominated: Stat | undefined;
  for (const s of stats.values()) {
    if (s.type !== 'candidate-pair') continue;
    if (s.selected === true) return s;
    if (!nominated && s.nominated === true && s.state === 'succeeded') nominated = s;
  }
  return nominated;
}

function pathOf(stats: Map<string, Stat>, pair: Stat): CallStats['path'] {
  const local = typeof pair.localCandidateId === 'string' ? stats.get(pair.localCandidateId) : undefined;
  if (!local) return null;
  const protocol = local.protocol === 'tcp' ? 'tcp' : local.protocol === 'udp' ? 'udp' : null;
  if (local.candidateType === 'relay') {
    const via = local.relayProtocol;
    return via === 'tls' ? 'relay-tls' : via === 'tcp' ? 'relay-tcp' : 'relay-udp';
  }
  return protocol;
}

/**
 * Samples the room's WebRTC stats into `stats` events. The first sample on a fresh set of
 * transports (first join, rejoin, LiveKit full reconnect) only seeds the counters and returns null.
 * Never throws; a failed `getStats` reads as a missing sample.
 */
export function createStatsSampler(room: Room) {
  let prev: Counters | null = null;

  return {
    async sample(): Promise<CallStats | null> {
      try {
        const pcs = transports(room);
        if (!pcs || pcs.list.length === 0) {
          prev = null;
          return null;
        }
        const reports = await Promise.all(pcs.list.map((t) => t.getStats()?.catch(() => undefined)));
        const now = Date.now();

        let rttMs: number | null = null;
        let path: CallStats['path'] = null;
        let availOutKbps: number | null = null;
        let jitter: number | null = null;
        let remoteLoss: number | null = null;
        const out: Counters['out'] = new Map();
        const inbound: Counters['in'] = new Map();

        const microphoneTrackId = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.sender?.track?.id;
        for (const [i, report] of reports.entries()) {
          if (!report) continue;
          const stats = new Map<string, Stat>();
          report.forEach((s: Stat) => stats.set(s.id, s));
          const pair = selectedPair(stats);
          if (pair) {
            const rtt = num(pair.currentRoundTripTime);
            if (rtt !== null && (rttMs === null || rtt * 1000 > rttMs)) {
              rttMs = rtt * 1000;
              path = pathOf(stats, pair) ?? path;
            } else if (path === null) {
              path = pathOf(stats, pair);
            }
            const avail = num(pair.availableOutgoingBitrate);
            if (avail !== null) availOutKbps = Math.max(availOutKbps ?? 0, avail / 1000);
          }
          for (const s of stats.values()) {
            const kind = (s.kind ?? s.mediaType) as string | undefined;
            // Ids are only unique per peer connection.
            const key = `${i}:${s.id}`;
            if (s.type === 'outbound-rtp' && kind) {
              out.set(key, { kind, bytes: num(s.bytesSent) ?? 0 });
            } else if (s.type === 'inbound-rtp' && kind) {
              inbound.set(key, {
                kind,
                bytes: num(s.bytesReceived) ?? 0,
                lost: num(s.packetsLost) ?? 0,
                received: num(s.packetsReceived) ?? 0,
                concealed: num(s.concealedSamples) ?? 0,
                samples: num(s.totalSamplesReceived) ?? 0,
              });
              const j = num(s.jitter);
              if (kind === 'audio' && j !== null) jitter = Math.max(jitter ?? 0, j * 1000);
            } else if (s.type === 'remote-inbound-rtp' && kind === 'audio') {
              const outbound = typeof s.localId === 'string' ? stats.get(s.localId) : undefined;
              const sourceId =
                typeof outbound?.mediaSourceId === 'string'
                  ? outbound.mediaSourceId
                  : typeof outbound?.trackId === 'string'
                    ? outbound.trackId
                    : undefined;
              const mediaSource = sourceId ? stats.get(sourceId) : undefined;
              const trackId = mediaSource?.trackIdentifier ?? outbound?.trackIdentifier;
              const f = num(s.fractionLost);
              if (microphoneTrackId && trackId === microphoneTrackId && f !== null) {
                remoteLoss = Math.max(remoteLoss ?? 0, f * 100);
              }
            }
          }
        }

        const last = prev;
        prev = { at: now, source: pcs.source, out, in: inbound };
        if (!last || last.source !== pcs.source || now <= last.at) return null;
        const seconds = (now - last.at) / 1000;

        // Kbps per kind from per-stream byte deltas; null when no stream of that kind spans the window.
        const rate = (cur: Map<string, { kind: string; bytes: number }>, old: typeof cur, kind: string) => {
          let bytes: number | null = null;
          for (const [key, s] of cur) {
            const o = old.get(key);
            if (s.kind !== kind || !o || s.bytes < o.bytes) continue;
            bytes = (bytes ?? 0) + s.bytes - o.bytes;
          }
          return bytes === null ? null : (bytes * 8) / 1000 / seconds;
        };

        let lost = 0;
        let received = 0;
        let concealed = 0;
        let samples = 0;
        for (const [key, s] of inbound) {
          const o = last.in.get(key);
          if (s.kind !== 'audio' || !o) continue;
          lost += Math.max(0, s.lost - o.lost);
          received += Math.max(0, s.received - o.received);
          concealed += Math.max(0, s.concealed - o.concealed);
          samples += Math.max(0, s.samples - o.samples);
        }

        return {
          rttMs: int(rttMs),
          path,
          upAudioKbps: int(rate(out, last.out, 'audio')),
          upVideoKbps: int(rate(out, last.out, 'video')),
          availOutKbps: int(availOutKbps),
          downAudioKbps: int(rate(inbound, last.in, 'audio')),
          downVideoKbps: int(rate(inbound, last.in, 'video')),
          audioLossPct: pct(lost + received > 0 ? (lost / (lost + received)) * 100 : null),
          audioJitterMs: int(jitter),
          concealedPct: pct(samples > 0 ? (concealed / samples) * 100 : null),
          remoteLossPct: pct(remoteLoss),
        };
      } catch {
        prev = null;
        return null;
      }
    },
  };
}
