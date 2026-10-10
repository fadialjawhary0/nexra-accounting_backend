/** "Chrome on Windows" and a kind (desktop · laptop · mobile · tablet) from a User-Agent header. */
export function describeDevice(userAgent: string | undefined): { device: string; kind: string } {
  const agent = userAgent ?? '';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(agent)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Web browser';
  const os = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad/.test(agent)
      ? 'iPad'
      : /Android/.test(agent)
        ? 'Android'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Mac OS X/.test(agent)
            ? 'macOS'
            : /Linux/.test(agent)
              ? 'Linux'
              : '';
  const kind = /iPhone|Android.+Mobile/.test(agent) ? 'mobile' : /iPad|Tablet/.test(agent) ? 'tablet' : /Macintosh|Windows|Linux/.test(agent) ? 'desktop' : 'desktop';
  return { device: os ? `${browser} on ${os}` : browser, kind };
}
