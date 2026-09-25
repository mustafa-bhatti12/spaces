export interface ConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
  /** This participant started the room, so they may end it for everyone. */
  host: boolean;
}

export type LeaveReason = {
  /** `ended`: this participant ended the call for everyone. */
  kind: 'left' | 'ended' | 'duplicate' | 'removed' | 'room-closed' | 'error';
  message?: string;
};
