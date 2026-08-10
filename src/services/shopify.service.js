const axios = require('axios');
const config = require('../config/shopify.config');

/**
 * Shopify Service
 * Purpose: Provides helper functions to interact with the Shopify Admin REST API.
 */

/**
 * Checks for existing webhook subscriptions and registers them on Shopify if missing.
 * Subscribes to:
 * 1. customers/create -> /webhook/customer
 * 2. products/create  -> /webhook/product
 * 3. orders/create    -> /webhook/order
 * 
 * @returns {Promise<void>}
 */
const registerWebhooks = async () => {
  const { shopifyStoreUrl, shopifyAccessToken, shopifyApiVersion, baseWebhookUrl } = config;

  // Gracefully handle missing/default config to prevent application startup crashes
  if (!shopifyStoreUrl || shopifyStoreUrl.includes('your-store.myshopify.com')) {
    console.warn('[Shopify Service] SHOPIFY_STORE_URL not configured. Skipping webhook registration.');
    return;
  }
  if (!shopifyAccessToken || shopifyAccessToken.includes('shpat_your_access_token')) {
    console.warn('[Shopify Service] SHOPIFY_ACCESS_TOKEN not configured. Skipping webhook registration.');
    return;
  }
  if (!baseWebhookUrl || baseWebhookUrl.includes('your-ngrok-url')) {
    console.warn('[Shopify Service] BASE_WEBHOOK_URL not configured. Skipping webhook registration.');
    return;
  }

  console.log('[Shopify Service] Checking existing webhooks...');

  try {
    // 1. Fetch existing webhooks from Shopify
    const response = await axios.get(
      `https://${shopifyStoreUrl}/admin/api/${shopifyApiVersion}/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': shopifyAccessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    const existingWebhooks = response.data.webhooks || [];
    
    // 2. Define the target webhooks we want registered
    const targetWebhooks = [
      { topic: 'customers/create', address: `${baseWebhookUrl}/webhook/customer` },
      { topic: 'products/create', address: `${baseWebhookUrl}/webhook/product` },
      { topic: 'orders/create', address: `${baseWebhookUrl}/webhook/order` }
    ];

    // 3. Register webhooks that do not already exist
    for (const target of targetWebhooks) {
      const exists = existingWebhooks.some(
        (wh) => wh.topic === target.topic && wh.address === target.address
      );

      if (exists) {
        console.log(`[Shopify Service] Webhook for "${target.topic}" at "${target.address}" is already registered.`);
      } else {
        console.log(`[Shopify Service] Registering webhook for "${target.topic}" at "${target.address}"...`);
        
        try {
          await axios.post(
            `https://${shopifyStoreUrl}/admin/api/${shopifyApiVersion}/webhooks.json`,
            {
              webhook: {
                topic: target.topic,
                address: target.address,
                format: 'json'
              }
            },
            {
              headers: {
                'X-Shopify-Access-Token': shopifyAccessToken,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log(`[Shopify Service] Successfully registered webhook for topic "${target.topic}".`);
        } catch (postError) {
          const apiError = postError.response && postError.response.data
            ? JSON.stringify(postError.response.data)
            : postError.message;
          console.error(`[Shopify Service] Failed to register webhook for topic "${target.topic}":`, apiError);
        }
      }
    }
  } catch (error) {
    const fetchError = error.response && error.response.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error('[Shopify Service] Error fetching existing Shopify webhooks:', fetchError);
  }
};

const getNextPageUrl = (linkHeader) => {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const parts = link.split(';');
    if (parts.length < 2) continue;
    if (parts[1].trim() === 'rel="next"') {
      const match = parts[0].trim().match(/<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return null;
};

const getAuthHeaders = (accessToken) => ({
  'X-Shopify-Access-Token': accessToken,
  'Content-Type': 'application/json'
});

/**
 * Push updated contact fields back to Shopify (Bitrix -> Shopify two-way sync).
 * Only fields the Shopify customers API accepts are sent.
 */
const updateShopifyCustomer = async (shopifyId, fields, shopDomain, accessToken) => {
  const customer = {
    first_name: fields.NAME || fields.first_name || '',
    last_name: fields.LAST_NAME || fields.last_name || '',
    email: fields.email || '',
    phone: fields.phone || '',
    tags: fields.tags || '',
    note: fields.note || '',
    verified_email: true
  };

  const response = await axios.put(
    `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/${shopifyId}.json`,
    { customer },
    { headers: getAuthHeaders(accessToken) }
  );
  return response.data.customer;
};

/**
 * Fetch all orders for a Shopify customer (paged), for lifetime metric computation.
 */
const getCustomerOrders = async (customerId, shopDomain, accessToken, maxPages = 20) => {
  const orders = [];
  let url = `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/customers/${customerId}/orders.json?status=any&limit=250`;
  let pages = 0;

  while (url && pages < maxPages) {
    const response = await axios.get(url, { headers: getAuthHeaders(accessToken) });
    orders.push(...(response.data.orders || []));
    url = getNextPageUrl(response.headers.link);
    pages++;
  }
  return orders;
};

/**
 * Update a Shopify customer (generic wrapper used by two-way sync).
 */
const updateCustomerByFields = async (shopifyId, contact, shopDomain, accessToken) => {
  const email = contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '';
  const phone = contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : '';
  return updateShopifyCustomer(shopifyId, {
    first_name: contact.NAME,
    last_name: contact.LAST_NAME,
    email,
    phone,
    tags: (contact.TAG && contact.TAG.length ? contact.TAG.join(', ') : '') || contact.UF_CRM_CUSTOMER_TAGS || '',
    note: contact.UF_CRM_CUSTOMER_NOTE || ''
  }, shopDomain, accessToken);
};

module.exports = {
  registerWebhooks,
  updateShopifyCustomer,
  updateCustomerByFields,
  getCustomerOrders
};
