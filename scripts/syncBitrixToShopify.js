require('dotenv').config();
const axios = require('axios');
const shopifyService = require('../src/services/shopify.service');

/**
 * Pull Bitrix contacts that were modified since a given date and have a
 * UF_CRM_SHOPIFY_ID, then push their latest values to Shopify.
 *
 * Usage:
 *   node scripts/syncBitrixToShopify.js
 *   node scripts/syncBitrixToShopify.js "2026-08-01T00:00:00"
 */
const sync = async (since, shopDomain, accessToken, webhookUrl) => {
  if (!webhookUrl || webhookUrl.includes('xxxxxxxxxxxxxxxx')) {
    console.error('BITRIX_WEBHOOK_URL is not configured in .env.');
    process.exit(1);
  }
  if (!shopDomain || !accessToken) {
    console.error('Shopify credentials not configured in .env (SHOPIFY_STORE_URL / SHOPIFY_ACCESS_TOKEN).');
    process.exit(1);
  }

  const post = async (method, payload) => {
    const url = `${webhookUrl}${method}`;
    const res = await axios.post(url, payload);
    return res.data;
  };

  const filter = {};
  if (since) filter[">DATE_MODIFY"] = since;

  let start = 0;
  let pushed = 0;
  let skipped = 0;

  while (true) {
    const data = await post('crm.contact.list', {
      filter,
      select: ["ID", "NAME", "LAST_NAME", "EMAIL", "PHONE", "TAG", "UF_CRM_SHOPIFY_ID", "UF_CRM_CUSTOMER_NOTE", "DATE_MODIFY"],
      start
    });

    const contacts = data.result || [];
    if (contacts.length === 0) break;

    for (const contact of contacts) {
      if (!contact.UF_CRM_SHOPIFY_ID) { skipped++; continue; }
      try {
        await shopifyService.updateCustomerByFields(contact.UF_CRM_SHOPIFY_ID, contact, shopDomain, accessToken);
        pushed++;
        console.log(`Pushed contact ${contact.ID} -> Shopify customer ${contact.UF_CRM_SHOPIFY_ID}`);
      } catch (err) {
        console.error(`Failed contact ${contact.ID} (Shopify ${contact.UF_CRM_SHOPIFY_ID}):`, err.message);
      }
    }

    const next = data.next;
    if (!next) break;
    start = next;
  }

  console.log(`Done (${shopDomain}). Pushed: ${pushed}, skipped (no Shopify ID): ${skipped}`);
};

const sinceArg = process.argv[2] || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

sync(sinceArg, process.env.SHOPIFY_STORE_URL, process.env.SHOPIFY_ACCESS_TOKEN, process.env.BITRIX_WEBHOOK_URL)
  .catch((err) => {
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
