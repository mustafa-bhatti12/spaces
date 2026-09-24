export interface ConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

export type LeaveReason = {
  kind: 'left' | 'duplicate' | 'removed' | 'room-closed' | 'error';
  message?: string;
};
