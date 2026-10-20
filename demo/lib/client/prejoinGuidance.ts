import { isBrowserSupported } from 'livekit-client';

const IN_APP_WEBVIEW = /GSA\/|Instagram|FBAN|FBAV|FB_IAB|WhatsApp|Line\/|MicroMessenger|TikTok|Snapchat|LinkedInApp|Discord|;\s*wv\)/i;

export function getPreJoinBrowserStatus(userAgent: string) {
  return {
    unsupported: !isBrowserSupported() || IN_APP_WEBVIEW.test(userAgent),
    firefox: /Firefox\/|FxiOS\//i.test(userAgent),
  };
}

export function previewErrorMessage(error: Error, userAgent: string, maxTouchPoints = 0): string {
  if (error.name === 'NotFoundError' || /requested device not found/i.test(error.message)) {
    return 'No camera or microphone found. Turn off the missing device above to join audio-only or listen-only.';
  }

  if (error.name !== 'NotAllowedError' && !/permission denied|dismissed|not allowed by the user agent/i.test(error.message)) {
    return error.message;
  }
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  let instructions = 'Allow camera and microphone in your browser site settings.';
  if (/Firefox|FxiOS/i.test(userAgent)) {
    instructions = 'Select the permissions icon in the address bar and allow Camera and Microphone.';
  } else if (/Edg|Edge|Chrome|CriOS/i.test(userAgent)) {
    instructions = 'Select the lock icon beside the address, open Site settings, and allow Camera and Microphone.';
  } else if (/Safari/i.test(userAgent)) {
    instructions = isIOS
      ? 'In iOS Settings, allow Camera and Microphone for Safari.'
      : 'In Safari Settings → Websites, allow Camera and Microphone for this site.';
  }

  const macOS = /Macintosh|Mac OS X/i.test(userAgent) && !isIOS
    ? ' On macOS, also check System Settings → Privacy & Security → Camera and Microphone, and allow access for your browser.'
    : '';
  return `We couldn't access your camera or microphone. ${instructions}${macOS}`;
}
