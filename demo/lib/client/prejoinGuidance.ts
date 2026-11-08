import { isBrowserSupported } from 'livekit-client';

const IN_APP_WEBVIEW = /GSA\/|Instagram|FBAN|FBAV|FB_IAB|WhatsApp|Line\/|MicroMessenger|TikTok|Snapchat|LinkedInApp|Discord|;\s*wv\)/i;

export function getPreJoinBrowserStatus(userAgent: string) {
  return {
    unsupported: !isBrowserSupported() || IN_APP_WEBVIEW.test(userAgent),
    firefox: /Firefox\/|FxiOS\//i.test(userAgent),
  };
}

/** Which device failed: LiveKit's `MediaDeviceKind`, or both when the browser didn't say. */
export type FailedDevice = 'audioinput' | 'videoinput' | undefined;

export interface DeviceHelp {
  kind: 'blocked' | 'missing' | 'busy' | 'other';
  /** Short headline: "Microphone blocked". */
  title: string;
  /** Steps that fix it on this browser, in order. Empty when there's nothing specific to do. */
  steps: string[];
  /** Where to look if the steps didn't do it (the OS-level switch). */
  fallback?: string;
  /** The browser's own message, for errors we don't recognise. */
  message?: string;
}

/** Where this browser keeps the page's camera/microphone permission. */
function permissionSteps(userAgent: string, iOS: boolean, what: string): string[] {
  if (iOS) {
    // Every iOS browser is WebKit: the site setting lives in the browser, the app setting in iOS.
    if (/CriOS|FxiOS|EdgiOS/i.test(userAgent)) return ['Open iOS Settings → Apps → this browser', `Turn on ${what}, then come back`];
    return ['Tap aA in the address bar → Website Settings', `Set ${what} to Allow`];
  }
  if (/SamsungBrowser/i.test(userAgent)) return ['Tap the icon left of the address → Permissions', `Allow ${what}`];
  if (/Firefox/i.test(userAgent)) return ['Click the permissions icon in the address bar', `Allow ${what}`];
  if (/Edg|Chrome/i.test(userAgent)) {
    return [`${/Android/i.test(userAgent) ? 'Tap' : 'Click'} the icon beside the address → Site settings`, `Allow ${what}`];
  }
  if (/Safari/i.test(userAgent)) return ['Open Safari → Settings → Websites', `Allow ${what} for this site`];
  return [`Allow ${what} in your browser's site settings`];
}

export function deviceHelp(error: Error, userAgent: string, maxTouchPoints = 0, device?: FailedDevice): DeviceHelp {
  const Name = device === 'audioinput' ? 'Microphone' : device === 'videoinput' ? 'Camera' : 'Camera and microphone';
  const noun = device === 'audioinput' ? 'microphone' : device === 'videoinput' ? 'camera' : 'camera or microphone';
  if (error.name === 'NotFoundError' || /requested device not found/i.test(error.message)) {
    return { kind: 'missing', title: `No ${noun} found`, steps: [`Connect a ${noun === 'camera or microphone' ? 'camera or headset' : noun}`, 'Or pick another one in Settings'] };
  }
  if (error.name === 'NotReadableError' || /device in use|could not start/i.test(error.message)) {
    return { kind: 'busy', title: `${Name} is in use`, steps: ['Close the other app or tab using it'] };
  }
  if (error.name !== 'NotAllowedError' && !/permission denied|dismissed|not allowed by the user agent/i.test(error.message)) {
    return { kind: 'other', title: `${Name} didn't start`, steps: [], message: error.message };
  }
  const iOS = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  const steps = permissionSteps(userAgent, iOS, device === 'audioinput' ? 'Microphone' : device === 'videoinput' ? 'Camera' : 'Camera and Microphone');
  const fallback = /Android/i.test(userAgent)
    ? 'Android Settings → Apps → this browser → Permissions'
    : iOS && !/CriOS|FxiOS|EdgiOS/i.test(userAgent)
      ? `iOS Settings → Apps → Safari → ${Name}`
      : /Macintosh|Mac OS X/i.test(userAgent) && !iOS
        ? `System Settings → Privacy & Security → ${Name}`
        : undefined;
  return { kind: 'blocked', title: `${Name} blocked`, steps, fallback };
}

/** The same help as one line, for the pre-join's error note. */
export function previewErrorMessage(error: Error, userAgent: string, maxTouchPoints = 0): string {
  const help = deviceHelp(error, userAgent, maxTouchPoints);
  if (help.kind === 'other') return help.message ?? help.title;
  if (help.kind === 'missing') return 'No camera or microphone found. Turn off the missing device above to join audio-only or listen-only.';
  // The pre-join has no Try again key: reloading re-asks.
  const fallback = help.fallback ? ` Still blocked? ${help.fallback}.` : '';
  return `${help.title}. ${help.steps.join('. ')}, then reload this page.${fallback}`;
}
