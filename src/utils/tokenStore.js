const pool = require('../config/db.config');

async function saveToken(shop, accessToken) {
  await pool.query(
    `INSERT INTO shop_tokens (shop, access_token) VALUES ($1, $2)
     ON CONFLICT (shop) DO UPDATE SET access_token = $2`,
    [shop, accessToken]
  );
}

async function getToken(shop) {
  const result = await pool.query('SELECT access_token FROM shop_tokens WHERE shop = $1', [shop]);
  return result.rows.length > 0 ? result.rows[0].access_token : null;
}

async function deleteToken(shop) {
  await pool.query('DELETE FROM shop_tokens WHERE shop = $1', [shop]);
}

module.exports = { saveToken, getToken, deleteToken };
