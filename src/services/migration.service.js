const axios = require('axios');
const shopifyConfig = require('../config/shopify.config');
const bitrixService = require('./bitrix.service');
const { getTenantConfig } = require('../utils/tenantContext');

const getNextPageUrl = (linkHeader) => {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const parts = link.split(';');
    if (parts.length < 2) continue;
    const urlPart = parts[0].trim();
    const relPart = parts[1].trim();
    if (relPart === 'rel="next"') {
      const urlMatch = urlPart.match(/<([^>]+)>/);
      if (urlMatch) return urlMatch[1];
    }
  }
  return null;
};

// Resolve the Shopify store + token for the current tenant (falls back to .env).
const resolveShopify = async () => {
  const tenant = getTenantConfig();
  const shopDomain = tenant.storeDomain || '';
  const shopifyApiVersion = tenant.apiVersion || shopifyConfig.shopifyApiVersion || '2024-10';
  let shopifyAccessToken = tenant.accessToken || '';
  if (!shopifyAccessToken) {
    shopifyAccessToken = await shopifyConfig.getShopifyAccessToken();
  }
  return { shopDomain, shopifyAccessToken, shopifyApiVersion };
};

const hasValidCredentials = ({ shopDomain, shopifyAccessToken }) =>
  Boolean(
    shopDomain &&
    !shopDomain.includes('your-store.myshopify.com') &&
    shopifyAccessToken &&
    !shopifyAccessToken.includes('shpat_your_access_token')
  );

const getShopifyCount = async (resource, creds) => {
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return 0;
  }

  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/${resource}/count.json`;
  if (resource === 'orders') {
    url += '?status=any';
  }

  try {
    const response = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
    });
    return response.data.count || 0;
  } catch (error) {
    console.error(`[Migration] Failed to get count for ${resource}:`, error.message);
    return 0;
  }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const migrateCustomers = async () => {
  const creds = await resolveShopify();
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return { success: false, error: 'Shopify credentials not configured.' };
  }

  const totalRecords = await getShopifyCount('customers', creds);
  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/customers.json?limit=250`;

  let processedCount = 0;
  let importedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  console.log(`[Migration] Starting Customer Migration (total: ${totalRecords})...`);

  while (url) {
    try {
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
      });

      const customers = response.data.customers || [];
      for (const customer of customers) {
        processedCount++;
        console.log(`[Migration] Customer ${processedCount}/${totalRecords || '?'} (Shopify ID: ${customer.id})`);

        try {
          // Pass store credentials so lifetime metrics + attribution are computed on import.
          await bitrixService.createOrUpdateContact(customer, {
            shopDomain,
            accessToken: shopifyAccessToken,
            apiVersion: shopifyApiVersion
          });
          importedCount++;
        } catch (innerError) {
          console.error(`[Migration] Customer FAILED (Shopify ID: ${customer.id}):`, innerError.message);
          failedCount++;
        }
      }

      const linkHeader = response.headers['link'] || response.headers['Link'];
      url = getNextPageUrl(linkHeader);
    } catch (outerError) {
      console.error('[Migration] Failed to fetch customers page:', outerError.message);
      break;
    }
  }

  console.log(`[Migration] Customer Migration Done — processed: ${processedCount}, imported: ${importedCount}, failed: ${failedCount}`);
  return { success: true, total: processedCount, imported: importedCount, updated: updatedCount, failed: failedCount };
};

const migrateProducts = async () => {
  const creds = await resolveShopify();
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return { success: false, error: 'Shopify credentials not configured.' };
  }

  const totalRecords = await getShopifyCount('products', creds);
  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/products.json?limit=250`;

  let processedCount = 0;
  let importedCount = 0;
  let failedCount = 0;

  const productsToSyncStock = [];

  console.log(`[Migration] Starting Product Migration (total: ${totalRecords})...`);

  while (url) {
    try {
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
      });

      const products = response.data.products || [];
      for (const product of products) {
        processedCount++;
        console.log(`[Migration] Product ${processedCount}/${totalRecords || '?'} (Shopify ID: ${product.id}, title: ${product.title})`);

        try {
          const bitrixProductId = await bitrixService.createOrUpdateProduct(
            product, shopDomain, shopifyAccessToken, shopifyApiVersion
          );
          importedCount++;

          if (bitrixProductId) {
            const variant = (product.variants && product.variants[0]) || {};
            const qty = variant.inventory_quantity !== undefined ? Math.max(variant.inventory_quantity, 0) : 0;
            productsToSyncStock.push({ shopifyId: product.id, bitrixProductId, qty, title: product.title });
          }
        } catch (innerError) {
          console.error(`[Migration] Product FAILED (Shopify ID: ${product.id}, title: ${product.title}):`, innerError.message);
          failedCount++;
        }
      }

      const linkHeader = response.headers['link'] || response.headers['Link'];
      url = getNextPageUrl(linkHeader);
    } catch (outerError) {
      console.error('[Migration] Failed to fetch products page:', outerError.message);
      break;
    }
  }

  console.log(`[Migration] Product creation done. Starting inventory sync for ${productsToSyncStock.length} products...`);

  let stockSynced = 0;
  let stockFailed = 0;

  for (const { shopifyId, bitrixProductId, qty, title } of productsToSyncStock) {
    try {
      await delay(2500);
      await bitrixService.syncProductStock(bitrixProductId, shopifyId, qty, title);
      stockSynced++;
    } catch (stockError) {
      console.error(`[Migration] Stock sync FAILED (Bitrix: ${bitrixProductId}, Shopify: ${shopifyId}, "${title}"):`, stockError.message);
      stockFailed++;
    }
  }

  console.log(`[Migration] Product Migration Complete — processed: ${processedCount}, created/updated: ${importedCount}, failed: ${failedCount}, stock synced: ${stockSynced}, stock failed: ${stockFailed}`);

  return {
    success: true,
    total: processedCount,
    imported: importedCount,
    failed: failedCount,
    stockSynced,
    stockFailed
  };
};

const migrateOrders = async () => {
  const creds = await resolveShopify();
  const { shopDomain, shopifyAccessToken, shopifyApiVersion } = creds;

  if (!hasValidCredentials(creds)) {
    return { success: false, error: 'Shopify credentials not configured.' };
  }

  const totalRecords = await getShopifyCount('orders', creds);
  let url = `https://${shopDomain}/admin/api/${shopifyApiVersion}/orders.json?limit=250&status=any`;

  let processedCount = 0;
  let importedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  const uniqueCustomerIds = new Set();

  const opts = {
    shopDomain,
    accessToken: shopifyAccessToken,
    apiVersion: shopifyApiVersion
  };

  console.log(`[Migration] Starting Order Migration (total: ${totalRecords})...`);

  while (url) {
    try {
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' }
      });

      const orders = response.data.orders || [];
      for (const order of orders) {
        processedCount++;
        const orderNumber = order.order_number || order.name || order.id || 'N/A';
        console.log(`[Migration] Order ${processedCount}/${totalRecords || '?'} (#${orderNumber}, Shopify ID: ${order.id})`);

        try {
          const dealId = await bitrixService.createOrUpdateDeal(order, opts);
          importedCount++;
          if (order.customer && order.customer.id) uniqueCustomerIds.add(order.customer.id);

          const invoiceService = require('./invoice.service');
          await invoiceService.syncInvoice(order, dealId, opts);
        } catch (innerError) {
          console.error(`[Migration] Order FAILED (Shopify ID: ${order.id}, #${orderNumber}):`, innerError.message);
          failedCount++;
        }
      }

      const linkHeader = response.headers['link'] || response.headers['Link'];
      url = getNextPageUrl(linkHeader);
    } catch (outerError) {
      console.error('[Migration] Failed to fetch orders page:', outerError.message);
      break;
    }
  }

  console.log(`[Migration] Order Migration Done — processed: ${processedCount}, imported: ${importedCount}, failed: ${failedCount}`);

  // Backfill lifetime metrics once per unique customer (deduped — avoids O(n^2)).
  const lifetimeService = require('./lifetime.service');
  let lifetimeRefreshed = 0;
  let lifetimeFailed = 0;
  for (const customerId of uniqueCustomerIds) {
    try {
      await lifetimeService.refreshContactLifetime(customerId, opts);
      lifetimeRefreshed++;
    } catch (err) {
      lifetimeFailed++;
      console.error(`[Migration] Lifetime refresh failed for customer ${customerId}:`, err.message);
    }
  }
  console.log(`[Migration] Lifetime metrics refreshed for ${lifetimeRefreshed} customers (${lifetimeFailed} failed)`);

  return { success: true, total: processedCount, imported: importedCount, updated: updatedCount, failed: failedCount, lifetimeRefreshed };
};

const migrateAll = async () => {
  const customerStats = await migrateCustomers();
  console.log('---------------------------------');
  const productStats = await migrateProducts();
  console.log('---------------------------------');
  const orderStats = await migrateOrders();
  console.log('---------------------------------');
  console.log('[Migration] All migrations completed');

  return {
    success: true,
    customers: customerStats,
    products: productStats,
    orders: orderStats
  };
};

module.exports = {
  migrateCustomers,
  migrateProducts,
  migrateOrders,
  migrateAll
};
