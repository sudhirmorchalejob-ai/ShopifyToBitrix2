const pool = require('../config/db.config');

// Resolve the shop for a mapping: explicit arg > .env store > legacy ('')
const shopOf = (shop) => shop || process.env.SHOPIFY_STORE_URL || '';

const LEGACY = 'legacy';

async function setMapping(type, shopifyId, bitrixId, shop) {
  const s = shopOf(shop);
  try {
    await pool.query(
      `INSERT INTO id_map (shop, type, shopify_id, bitrix_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop, type, shopify_id) DO UPDATE SET bitrix_id = $4`,
      [s, type, String(shopifyId), String(bitrixId)]
    );
  } catch (err) {
    // Pre-migration schema (no shop column): fall back to legacy key.
    await pool.query(
      `INSERT INTO id_map (type, shopify_id, bitrix_id) VALUES ($1, $2, $3)
       ON CONFLICT (type, shopify_id) DO UPDATE SET bitrix_id = $3`,
      [type, String(shopifyId), String(bitrixId)]
    );
  }
}

async function getMapping(type, shopifyId, shop) {
  const s = shopOf(shop);
  try {
    const result = await pool.query(
      'SELECT bitrix_id FROM id_map WHERE shop = $1 AND type = $2 AND shopify_id = $3',
      [s, type, String(shopifyId)]
    );
    if (result.rows.length > 0) return result.rows[0].bitrix_id;
  } catch (err) {
    return LEGACY;
  }
  return null;
}

// Fallback lookup using the old (shop-less) schema.
async function getMappingLegacy(type, shopifyId) {
  const result = await pool.query(
    'SELECT bitrix_id FROM id_map WHERE type = $1 AND shopify_id = $2',
    [type, String(shopifyId)]
  );
  return result.rows.length > 0 ? result.rows[0].bitrix_id : null;
}

async function getMappingWithFallback(type, shopifyId, shop) {
  const mapped = await getMapping(type, shopifyId, shop);
  if (mapped === LEGACY) {
    return await getMappingLegacy(type, shopifyId);
  }
  return mapped;
}

async function deleteMapping(type, shopifyId, shop) {
  const s = shopOf(shop);
  try {
    await pool.query(
      'DELETE FROM id_map WHERE shop = $1 AND type = $2 AND shopify_id = $3',
      [s, type, String(shopifyId)]
    );
  } catch (err) {
    await pool.query('DELETE FROM id_map WHERE type = $1 AND shopify_id = $2', [type, String(shopifyId)]);
  }
}

module.exports = {
  setMapping,
  getMapping,
  getMappingLegacy,
  getMappingWithFallback,
  deleteMapping
};
