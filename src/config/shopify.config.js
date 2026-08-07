const { getToken } = require('../utils/tokenStore');

const rawStoreUrl = process.env.SHOPIFY_STORE_URL || '';
const cleanStoreUrl = rawStoreUrl
  .replace(/^https?:\/\//i, '')
  .replace(/\/$/, '');

module.exports = {
  shopifyStoreUrl: cleanStoreUrl,
  getShopifyAccessToken: async () => (await getToken(cleanStoreUrl)) || process.env.SHOPIFY_ACCESS_TOKEN || '',
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
  baseWebhookUrl: process.env.SHOPIFY_APP_URL || ''
};
