export function subscriptionValid(subscription) {
  try {
    const endpoint = new URL(subscription.endpoint);
    return endpoint.protocol === 'https:' && endpoint.hostname.endsWith('.push.apple.com') &&
      !endpoint.port && !endpoint.username && !endpoint.password &&
      /^[\w-]{87}$/.test(subscription.keys.p256dh) && /^[\w-]{22}$/.test(subscription.keys.auth);
  } catch {
    return false;
  }
}
