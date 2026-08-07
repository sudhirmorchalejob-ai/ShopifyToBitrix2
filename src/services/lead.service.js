const bitrixService = require('./bitrix.service');
const attributionService = require('./attribution.service');
const config = require('../config/bitrix.config');
const { getTenantConfig } = require('../utils/tenantContext');
const { setMapping, getMappingWithFallback } = require('../utils/idMapStore');

const formatLineItems = (items) => (items || [])
  .map((i) => `- ${i.title || i.name || 'Item'} x ${i.quantity || 1} @ ${i.price || 0}`)
  .join('\n');

const toContact = (source) => {
  const customer = { email: source.email || '' };
  const name = (source.customer && (source.customer.first_name || source.customer.last_name))
    ? source.customer
    : (source.name || '').split(' ').reduce((acc, part, idx) => {
        if (idx === 0) acc.first_name = part;
        else acc.last_name = `${acc.last_name || ''} ${part}`.trim();
        return acc;
      }, {});
  customer.first_name = name.first_name || '';
  customer.last_name = name.last_name || '';
  customer.phone = (source.customer && source.customer.phone) || source.phone || '';
  return customer;
};

/**
 * Ensure a Bitrix contact exists for the email (lightweight — never triggers
 * lifetime computation or Shopify API calls).
 */
const ensureContactForLead = async (source) => {
  if (!source.email) return null;
  try {
    return await bitrixService.createOrUpdateContact(toContact(source), { skipLifetime: true });
  } catch (err) {
    console.error('[Lead] Contact creation failed for lead:', err.message);
    return null;
  }
};

const upsertLead = async (mappingType, shopifyKey, fields) => {
  const existing = await getMappingWithFallback(mappingType, shopifyKey);
  if (existing) {
    await bitrixService.bitrixRequest('crm.lead.update', { id: existing, fields });
    return existing;
  }
  const data = await bitrixService.bitrixRequest('crm.lead.add', { fields });
  const leadId = data?.result;
  if (leadId) {
    await setMapping(mappingType, shopifyKey, leadId);
  }
  return leadId;
};

/**
 * carts/update webhook -> Abandoned Cart lead.
 * Only creates/updates a lead once Shopify marks the cart as abandoned
 * (abandoned_checkout_url present).
 */
const syncLeadFromCart = async (cart, opts) => {
  if (!cart || !cart.id) return null;

  const tenant = getTenantConfig();
  const mappingType = 'leads';
  const abandonedUrl = cart.abandoned_checkout_url || '';
  const existing = await getMappingWithFallback(mappingType, cart.id);

  if (!abandonedUrl) {
    if (existing) {
      // Cart updated but not yet abandoned — refresh totals only.
      await bitrixService.bitrixRequest('crm.lead.update', {
        id: existing,
        fields: {
          OPPORTUNITY: parseFloat(cart.total_price || cart.subtotal_price || 0),
          UF_CRM_CART_TOTAL: String(cart.total_price || ''),
          UF_CRM_ABANDONED_URL: ''
        }
      });
    }
    return null;
  }

  const contactId = await ensureContactForLead(cart);
  const att = attributionService.parseUtmFromUrl(cart.landing_site);

  const fields = {
    TITLE: `Abandoned Cart${cart.email ? ` — ${cart.email}` : ''}`,
    OPPORTUNITY: parseFloat(cart.total_price || cart.subtotal_price || 0),
    CURRENCY_ID: tenant.currencyId,
    STATUS_ID: config.abandonedCartLeadStage,
    ASSIGNED_BY_ID: tenant.responsibleId,
    UF_CRM_LEAD_SOURCE: 'Shopify Abandoned Cart',
    UF_CRM_CART_TYPE: 'abandoned',
    UF_CRM_CART_ID: String(cart.id),
    UF_CRM_ABANDONED_URL: abandonedUrl,
    UF_CRM_CART_TOTAL: String(cart.total_price || ''),
    UF_CRM_UTM_SOURCE: att.utm_source,
    UF_CRM_UTM_MEDIUM: att.utm_medium,
    UF_CRM_UTM_CAMPAIGN: att.utm_campaign,
    COMMENTS: `Abandoned checkout: ${abandonedUrl}\n\n${formatLineItems(cart.line_items)}`
  };
  if (contactId) fields.CONTACT_ID = contactId;

  try {
    const leadId = await upsertLead(mappingType, cart.id, fields);
    console.log(`[AbandonedCart] Lead ${existing ? 'updated' : 'created'} (${leadId}) for cart ${cart.id}`);
    return leadId;
  } catch (err) {
    console.error('[AbandonedCart] Lead sync failed for cart', cart.id, ':', err.message);
    return null;
  }
};

/**
 * checkouts/create webhook -> Checkout Started lead.
 */
const syncLeadFromCheckout = async (checkout, opts) => {
  if (!checkout || !checkout.id) return null;

  const tenant = getTenantConfig();
  const mappingType = 'checkouts';
  const existing = await getMappingWithFallback(mappingType, checkout.id);
  const att = attributionService.extractAttribution(checkout);
  const contactId = await ensureContactForLead(checkout);

  const converted = checkout.completed_at || checkout.order;
  const fields = {
    TITLE: `Checkout Started${checkout.email ? ` — ${checkout.email}` : ''}`,
    OPPORTUNITY: parseFloat(checkout.total_price || checkout.subtotal_price || 0),
    CURRENCY_ID: tenant.currencyId,
    STATUS_ID: converted ? 'WON' : config.checkoutLeadStage,
    ASSIGNED_BY_ID: tenant.responsibleId,
    UF_CRM_LEAD_SOURCE: `Shopify Checkout (${att.channel || 'web'})`,
    UF_CRM_CART_TYPE: 'checkout',
    UF_CRM_CART_ID: String(checkout.id),
    UF_CRM_ABANDONED_URL: checkout.abandoned_checkout_url || '',
    UF_CRM_CART_TOTAL: String(checkout.total_price || ''),
    UF_CRM_UTM_SOURCE: att.utm_source,
    UF_CRM_UTM_MEDIUM: att.utm_medium,
    UF_CRM_UTM_CAMPAIGN: att.utm_campaign,
    COMMENTS: [
      checkout.email ? `Email: ${checkout.email}` : '',
      checkout.shipping_address ? `Shipping: ${[checkout.shipping_address.city, checkout.shipping_address.province, checkout.shipping_address.country].filter(Boolean).join(', ')}` : '',
      att.landing_site ? `Landing: ${att.landing_site}` : '',
      att.referring_site ? `Referring: ${att.referring_site}` : '',
      formatLineItems(checkout.line_items)
    ].filter(Boolean).join('\n')
  };
  if (contactId) fields.CONTACT_ID = contactId;

  try {
    const leadId = await upsertLead(mappingType, checkout.id, fields);
    console.log(`[Checkout] Lead ${existing ? 'updated' : 'created'} (${leadId}) for checkout ${checkout.id}`);
    return leadId;
  } catch (err) {
    console.error('[Checkout] Lead sync failed for checkout', checkout.id, ':', err.message);
    return null;
  }
};

module.exports = { syncLeadFromCart, syncLeadFromCheckout, ensureContactForLead };
