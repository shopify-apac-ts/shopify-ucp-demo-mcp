const TOKEN_ENDPOINT = 'https://api.shopify.com/auth/access_token';
// Shopify documents a 60-minute token lifetime, but the /auth/access_token
// response does not include an `expires_in` field — verified 2026-05-19.
// Hardcode the documented TTL and refresh 5 minutes early to avoid races.
const TOKEN_TTL_MS = 60 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
// Shared in-flight refresh — without this, concurrent callers seeing an
// expired token would each fire their own /auth/access_token request.
let inflight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set');
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // api.shopify.com sits behind Cloudflare's bot management which 403s
      // requests with no/unknown User-Agent (especially from datacenter
      // IPs like Cloudflare Workers). A realistic UA may not be sufficient
      // when the egress IP is in the Cloudflare range, but it removes the
      // most obvious bot signal.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
  };

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

export async function getBearerToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchToken().finally(() => {
    inflight = null;
  });
  return inflight;
}
