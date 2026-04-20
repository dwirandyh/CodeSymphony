type MobileDeviceViewerControlContext = {
  coarsePointer: boolean;
  hostname: string;
  protocol: string;
  userAgent: string;
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MOBILE_USER_AGENT_PATTERN = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

function parseIpv4Hostname(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

export function isLikelyLanHost(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase();
  if (normalizedHostname.length === 0 || LOOPBACK_HOSTNAMES.has(normalizedHostname)) {
    return false;
  }

  if (normalizedHostname.endsWith(".local")) {
    return true;
  }

  if (normalizedHostname.startsWith("fe80:") || normalizedHostname.startsWith("fc") || normalizedHostname.startsWith("fd")) {
    return true;
  }

  const ipv4 = parseIpv4Hostname(normalizedHostname);
  if (!ipv4) {
    return false;
  }

  const [firstOctet, secondOctet] = ipv4;
  return firstOctet === 10
    || firstOctet === 192 && secondOctet === 168
    || firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31
    || firstOctet === 169 && secondOctet === 254;
}

export function isLikelyMobileUserAgent(userAgent: string, coarsePointer: boolean): boolean {
  return coarsePointer || MOBILE_USER_AGENT_PATTERN.test(userAgent);
}

export function shouldShowMobileDeviceViewerControls(context: MobileDeviceViewerControlContext): boolean {
  return (context.protocol === "http:" || context.protocol === "https:")
    && isLikelyLanHost(context.hostname)
    && isLikelyMobileUserAgent(context.userAgent, context.coarsePointer);
}

export function getMobileDeviceViewerControlsFlag(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches
    : false;

  return shouldShowMobileDeviceViewerControls({
    coarsePointer,
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    userAgent: navigator.userAgent,
  });
}

export function supportsAndroidNativeViewer(): boolean {
  return typeof window !== "undefined"
    && typeof WebSocket === "function"
    && window.isSecureContext === true
    && typeof VideoDecoder === "function"
    && typeof EncodedVideoChunk === "function";
}

export function supportsIosNativeViewer(): boolean {
  return typeof window !== "undefined"
    && typeof WebSocket === "function"
    && typeof createImageBitmap === "function";
}
