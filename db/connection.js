const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT) || 3306,
  user: process.env.DATABASE_USER || 'root',
  password: process.env.DATABASE_PASSWORD || '',
  database: process.env.DATABASE_NAME || 'ecommerce',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  // BIGINT: return as strings so we never lose precision past 2^53.
  //   If you know none of your BIGINTs exceed 2^53 and you want numbers,
  //   set bigNumberStrings:false + supportBigNumbers:true.
  supportBigNumbers: true,
  bigNumberStrings: true,
  // DECIMAL: keep as strings. Do currency math with a decimal library
  //   (e.g. decimal.js), not IEEE-754 doubles. Flip to `true` only if
  //   you've audited every DECIMAL column for safe range.
  decimalNumbers: false,
  // Keep DATE/DATETIME as JS Date, interpreted in UTC (timezone:'Z' above).
  dateStrings: false,
  // Automatically Convert All TINYINT(1) to Boolean
  typeCast: function (field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      return field.string() === '1'; // Returns true if 1, false if 0
    }
    return next();
  },
});

// Force every pooled connection to UTC.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (err) throw err;
  });
});

module.exports = pool;
