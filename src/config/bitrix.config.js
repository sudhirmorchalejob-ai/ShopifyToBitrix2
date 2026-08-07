module.exports = {
  bitrixWebhookUrl: process.env.BITRIX_WEBHOOK_URL || '',
  currencyId: process.env.BITRIX_CURRENCY || 'INR',
  storeDomain: process.env.BITRIX_STORE_DOMAIN || '',
  warehouseId: parseInt(process.env.BITRIX_WAREHOUSE_ID, 10) || 2,
  responsibleId: parseInt(process.env.BITRIX_RESPONSIBLE_ID, 10) || 1,

  // Lifetime metrics & attribution roll-up (true/false)
  computeLifetime: process.env.COMPUTE_LIFETIME === 'true',

  // Lead (abandoned cart / checkout) settings
  leadResponsibleId: parseInt(process.env.BITRIX_LEAD_RESPONSIBLE_ID, 10) || 1,
  abandonedCartLeadStage: process.env.BITRIX_ABANDONED_CART_STAGE || 'NEW',
  checkoutLeadStage: process.env.BITRIX_CHECKOUT_STAGE || 'NEW',

  // Invoice sync
  invoiceSyncEnabled: process.env.BITRIX_INVOICE_SYNC_ENABLED === 'true',
  invoicePaySystemId: parseInt(process.env.BITRIX_INVOICE_PAY_SYSTEM_ID, 10) || 1,
  invoiceStatusId: process.env.BITRIX_INVOICE_STATUS_ID || '',

  // Two-way sync (Bitrix -> Shopify) shared secret for outbound webhooks
  syncToken: process.env.BITRIX_SYNC_TOKEN || ''
};
