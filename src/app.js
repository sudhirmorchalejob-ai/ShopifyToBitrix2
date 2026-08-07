require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();

const { saveToken, getToken, deleteToken } = require('./utils/tokenStore');
const { getMappingWithFallback, deleteMapping } = require('./utils/idMapStore');
const bitrixService = require('./services/bitrix.service');
const leadService = require('./services/lead.service');
const invoiceService = require('./services/invoice.service');
const lifetimeService = require('./services/lifetime.service');
const { shopifyWebhookVerifier } = require('./utils/webhook.middleware');
const migrationRoutes = require('./routes/migration.routes');
const syncRoutes = require('./routes/sync.routes');

const syncStockAfterDelay = (bitrixProductId, shopifyProductId, qty, productTitle, delayMs = 3000) => {
  setTimeout(async () => {
    try {
      await bitrixService.syncProductStock(bitrixProductId, shopifyProductId, qty, productTitle);
    } catch (err) {
      console.error(`[Webhook] Delayed stock sync failed (Bitrix: ${bitrixProductId}, Shopify: ${shopifyProductId}):`, err.message);
    }
  }, delayMs);
};

// Shared webhook plumbing: raw body -> HMAC verification -> handler.
// Handlers receive (payload, store) where store is built from .env credentials.
const webhookHandler = (handler) => [
  express.raw({ type: 'application/json' }),
  shopifyWebhookVerifier,
  async (req, res) => {
    try {
      const payload = JSON.parse(req.body.toString());
      const store = {
        shopDomain: process.env.SHOPIFY_STORE_URL || '',
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
        apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10'
      };
      await handler(payload, store);
      res.status(200).send('OK');
    } catch (err) {
      console.error('[Webhook] Handler failed:', err);
      res.status(500).send('Sync failed');
    }
  }
];

// ---------------- CUSTOMERS ----------------

app.post('/webhooks/shopify/customers-create', webhookHandler(async (customer, store) => {
  await bitrixService.createOrUpdateContact(customer, store);
}));

app.post('/webhooks/shopify/customers-update', webhookHandler(async (customer, store) => {
  await bitrixService.createOrUpdateContact(customer, store);
}));

app.post('/webhooks/shopify/customers-delete', webhookHandler(async ({ id }) => {
  const bitrixId = await getMappingWithFallback('contacts', id);
  if (bitrixId) {
    await bitrixService.deleteContactById(bitrixId);
    await deleteMapping('contacts', id);
  }
}));

// ---------------- PRODUCTS ----------------

const handleProductWebhook = async (product, store) => {
  const bitrixProductId = await bitrixService.createOrUpdateProduct(
    product, store.shopDomain, store.accessToken, store.apiVersion
  );
  if (bitrixProductId) {
    const variant = (product.variants && product.variants[0]) || {};
    const qty = variant.inventory_quantity !== undefined ? Math.max(variant.inventory_quantity, 0) : 0;
    syncStockAfterDelay(bitrixProductId, product.id, qty, product.title);
  }
};

app.post('/webhooks/shopify/products-create', webhookHandler(handleProductWebhook));
app.post('/webhooks/shopify/products-update', webhookHandler(handleProductWebhook));

app.post('/webhooks/shopify/products-delete', webhookHandler(async ({ id }) => {
  const bitrixId = await getMappingWithFallback('products', id);
  if (bitrixId) {
    await bitrixService.deleteProductById(bitrixId);
    await deleteMapping('products', id);
  }
}));

// ---------------- ORDERS ----------------

const handleOrderWebhook = async (order, store) => {
  const dealId = await bitrixService.createOrUpdateDeal(order, store);

  if (dealId) {
    await invoiceService.syncInvoice(order, dealId, store);

    const customerId = order.customer && order.customer.id;
    if (customerId) {
      await lifetimeService.refreshContactLifetime(customerId, store);
    }
  }
};

app.post('/webhooks/shopify/orders-create', webhookHandler(handleOrderWebhook));
app.post('/webhooks/shopify/orders-updated', webhookHandler(handleOrderWebhook));

app.post('/webhooks/shopify/orders-delete', webhookHandler(async ({ id }) => {
  const bitrixId = await getMappingWithFallback('deals', id);
  if (bitrixId) {
    await bitrixService.deleteDealById(bitrixId);
    await deleteMapping('deals', id);
  }
}));

// ---------------- ABANDONED CART / CHECKOUT ----------------

app.post('/webhooks/shopify/carts-update', webhookHandler(async (cart, store) => {
  await leadService.syncLeadFromCart(cart, store);
}));

app.post('/webhooks/shopify/checkouts-create', webhookHandler(async (checkout, store) => {
  await leadService.syncLeadFromCheckout(checkout, store);
}));

app.post('/webhooks/shopify/refunds-create', webhookHandler(async (refund) => {
  await bitrixService.applyRefund(refund);
}));

// ---------------- APP LIFECYCLE ----------------

app.post('/webhooks/shopify/app-uninstalled', webhookHandler(async (payload, ctx) => {
  const shop = payload.shop || ctx.shopDomain;
  if (shop) {
    await deleteToken(shop);
    console.log(`[App] Uninstalled — removed token for ${shop}`);
  }
}));

// Global JSON parsing — applies to all routes BELOW this line
app.use(express.json());

app.use('/migration', migrationRoutes);
app.use('/sync', syncRoutes);

app.get('/', (req, res) => res.send('OK Server is running'));

app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${process.env.SHOPIFY_APP_URL}/auth/callback`;

  const installUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_API_KEY}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing shop or code');

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });

    const data = await response.json();

    if (!data.access_token) {
      console.error('Token exchange failed:', data);
      return res.status(400).send('Failed to get access token');
    }

    await saveToken(shop, data.access_token);
    console.log(`Access token saved for ${shop}`);

    res.send('App installed successfully! You can close this tab.');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Something went wrong during installation');
  }
});

app.get('/test', async (req, res) => {
  const shop = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || (shop ? await getToken(shop) : '');
  if (!token) return res.status(404).send('No token found yet');

  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/customers.json?limit=5`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const data = await response.json();
  res.json(data);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
