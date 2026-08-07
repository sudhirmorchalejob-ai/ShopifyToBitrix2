/**
 * Shopify webhook registration (13 topics, idempotent) for a specific store.
 * Shared by scripts/registerWebhooks.js and the /admin/onboard endpoint.
 */

const TOPICS = [
  { topic: 'customers/create', route: 'customers-create' },
  { topic: 'customers/update', route: 'customers-update' },
  { topic: 'customers/delete', route: 'customers-delete' },
  { topic: 'products/create', route: 'products-create' },
  { topic: 'products/update', route: 'products-update' },
  { topic: 'products/delete', route: 'products-delete' },
  { topic: 'orders/create', route: 'orders-create' },
  { topic: 'orders/update', route: 'orders-updated' },
  { topic: 'orders/delete', route: 'orders-delete' },
  { topic: 'carts/update', route: 'carts-update' },
  { topic: 'checkouts/create', route: 'checkouts-create' },
  { topic: 'refunds/create', route: 'refunds-create' },
  { topic: 'app/uninstalled', route: 'app-uninstalled' }
];

const registerWebhooks = async ({ shop, accessToken, appUrl, apiVersion }) => {
  if (!shop || !accessToken || !appUrl) {
    throw new Error('shop, accessToken and appUrl are required to register webhooks');
  }
  const version = apiVersion || '2024-10';
  const results = [];

  // Fetch existing webhooks so registration is idempotent.
  const existingRes = await fetch(`https://${shop}/admin/api/${version}/webhooks.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken }
  });
  if (!existingRes.ok) {
    throw new Error(`Failed to list webhooks for ${shop}: HTTP ${existingRes.status}`);
  }
  const existing = (await existingRes.json()).webhooks || [];
  const existingKeys = new Set(existing.map((w) => `${w.topic}|${w.address}`));

  for (const { topic, route } of TOPICS) {
    const address = `${appUrl}/webhooks/shopify/${route}`;
    const key = `${topic}|${address}`;

    if (existingKeys.has(key)) {
      results.push({ topic, status: 'already-registered' });
      continue;
    }

    const response = await fetch(`https://${shop}/admin/api/${version}/webhooks.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ webhook: { topic, address, format: 'json' } })
    });
    const data = await response.json();
    if (data.webhook) {
      results.push({ topic, status: 'registered', id: data.webhook.id });
    } else {
      results.push({ topic, status: 'error', error: data.errors });
    }
  }

  return results;
};

module.exports = { registerWebhooks, TOPICS };
