// Thin wrapper over Expo's own push notification HTTP API -- no new
// dependency (plain fetch, one HTTP call). Mirrors school-eos-backend's own
// notifications/expo-push.util.ts exactly (same proven, already-live
// mechanism) -- this service's own copy, since the two are genuinely
// separate deployable services with no shared package between them.
//
// LLD §51: push contains generic information only, never message content --
// naturally guaranteed here, not just a policy, since this service never
// possesses plaintext to begin with (E2EE, LLD §22/§46-47).

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  priority?: 'default' | 'normal' | 'high';
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export async function sendExpoPush(
  message: ExpoPushMessage,
): Promise<ExpoPushTicket> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  const body = (await res.json()) as {
    data?: ExpoPushTicket;
    errors?: unknown[];
  };
  if (!res.ok || !body.data) {
    throw new Error(
      `Expo push failed (${res.status}): ${JSON.stringify(body)}`,
    );
  }
  return body.data;
}

export function isPlausibleExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[.+\]$/.test(token);
}
