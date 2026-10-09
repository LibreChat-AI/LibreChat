/**
 * Validates URLs to prevent SSRF attacks
 * @param {string} targetUrl - The URL to validate
 * @returns {string} - The validated URL
 * @throws {Error} - If the URL is invalid or potentially dangerous
 */
function validateUrl(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new Error('Invalid URL provided');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error('Malformed URL provided');
  }

  // Check protocol
  const allowedProtocols = ['https:', 'http:'];
  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    throw new Error(`Protocol ${parsedUrl.protocol} is not allowed`);
  }

  // Check for localhost, private IPs, and other dangerous hosts
  const hostname = parsedUrl.hostname.toLowerCase();

  // Block localhost variations
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    throw new Error('Localhost access is not allowed');
  }

  // Block private IP ranges
  if (isPrivateIP(hostname)) {
    throw new Error('Private IP addresses are not allowed');
  }

  // Block metadata services
  const metadataHosts = ['169.254.169.254', 'metadata.google.internal'];
  if (metadataHosts.includes(hostname)) {
    throw new Error('Metadata service access is not allowed');
  }

  return targetUrl;
}

/**
 * Checks if an IP address is in a private range
 * @param {string} ip - The IP address to check
 * @returns {boolean} - True if the IP is private
 */
function isPrivateIP(ip) {
  // IPv4 private ranges
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = ip.match(ipv4Regex);

  if (match) {
    const [, a, b, _c, _d] = match.map(Number);

    // 10.0.0.0/8
    if (a === 10) return true;

    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
  }

  // IPv6 private ranges (simplified check)
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
    return true;
  }

  return false;
}

module.exports = {
  validateUrl,
  isPrivateIP,
};
