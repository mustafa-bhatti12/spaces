export interface ConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

/** What this participant saw of the call, for the end screen. */
export interface CallSummary {
  /** From connecting to leaving. */
  durationMs: number;
  /** Everyone who was in the call at some point while we were, us included. */
  people: number;
}

export type LeaveReason = {
  /**
   * `ended`: this participant ended the call for everyone. `denied` / `no-response`: the waiting
   * room's answer (or 10 minutes without one), before ever joining.
   */
  kind: 'left' | 'ended' | 'duplicate' | 'removed' | 'room-closed' | 'error' | 'denied' | 'no-response';
  message?: string;
  summary?: CallSummary;
};
