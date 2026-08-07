const express = require('express');
const router = express.Router();
const bitrixService = require('../services/bitrix.service');
const shopifyService = require('../services/shopify.service');
const config = require('../config/bitrix.config');
const { getTenantConfig } = require('../utils/tenantContext');

/**
 * Two-way sync: Bitrix -> Shopify.
 *
 * Set up a Bitrix "Outgoing webhook" (Settings -> Integrations -> Webhooks)
 * for the contact.updated event pointing to:
 *   POST {SHOPIFY_APP_URL}/sync/bitrix/contact-update?token={BITRIX_SYNC_TOKEN}
 *
 * The Bitrix contact must have UF_CRM_SHOPIFY_ID populated (set automatically
 * by the Shopify -> Bitrix sync).
 */
const authorize = (req, res, next) => {
  const token = req.get('x-sync-token') || req.query.token;
  if (!config.syncToken) {
    return res.status(500).send('BITRIX_SYNC_TOKEN not configured');
  }
  if (token !== config.syncToken) {
    return res.status(401).send('Unauthorized');
  }
  next();
};

router.post('/bitrix/contact-update', authorize, async (req, res) => {
  try {
    const data = req.body?.data || {};
    const contactId = data.FIELDS?.ID || data.ID;
    if (!contactId) return res.status(400).send('Missing contact ID');

    const contact = await bitrixService.getContact(contactId);
    if (!contact) return res.status(404).send(`Contact ${contactId} not found`);

    const shopifyId = contact.UF_CRM_SHOPIFY_ID;
    if (!shopifyId) return res.status(200).send('No UF_CRM_SHOPIFY_ID on this contact — nothing to push');

    const { storeDomain: shopDomain, accessToken } = getTenantConfig();
    if (!shopDomain || !accessToken) return res.status(500).send('Shopify credentials not configured for this store');

    await shopifyService.updateCustomerByFields(shopifyId, contact, shopDomain, accessToken);
    console.log(`[TwoWay] Pushed Bitrix contact ${contactId} -> Shopify customer ${shopifyId}`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[TwoWay] Bitrix->Shopify contact sync failed:', err.message);
    res.status(err.status || 500).send(err.message);
  }
});

router.get('/health', (req, res) => res.status(200).send('sync routes OK'));

module.exports = router;
