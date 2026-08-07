/**
 * Attribution extraction from Shopify orders.
 * Maps landing_site UTMs + referring_site + source_name to structured fields.
 */
const parseUtmFromUrl = (url) => {
  const out = { utm_source: '', utm_medium: '', utm_campaign: '', utm_term: '', utm_content: '' };
  if (!url) return out;
  try {
    const parsed = new URL(url, 'https://localhost');
    for (const key of Object.keys(out)) {
      out[key] = parsed.searchParams.get(key) || '';
    }
  } catch (err) {
    // not a parseable URL — leave empty
  }
  return out;
};

const CHANNEL_MAP = {
  'pos': 'Point of Sale',
  'web': 'Online Store',
  'shopify_draft_order': 'Draft Order',
  'shopify_draft_orders': 'Draft Order'
};

const channelName = (sourceName) => CHANNEL_MAP[sourceName] || sourceName || 'N/A';

/**
 * Extract attribution fields from an order.
 * Returns fields that map directly onto Bitrix UF_CRM_* fields.
 */
const extractAttribution = (order) => {
  const utm = parseUtmFromUrl(order.landing_site);
  return {
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    utm_term: utm.utm_term,
    utm_content: utm.utm_content,
    landing_site: order.landing_site || '',
    referring_site: order.referring_site || '',
    source_name: order.source_name || '',
    channel: channelName(order.source_name)
  };
};

/**
 * Extract discount codes from order.discount_applications.
 */
const extractDiscountCodes = (order) => {
  const codes = [];
  for (const app of (order.discount_applications || [])) {
    const c = app.code || app.target_selection || '';
    if (c && !codes.includes(c)) codes.push(c);
  }
  return codes.join(', ');
};

module.exports = { parseUtmFromUrl, extractAttribution, extractDiscountCodes, channelName };
