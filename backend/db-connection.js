// 数据库连接模块
const mysql = require('mysql2');

// 创建连接池
const pool = mysql.createPool({
  host: 'localhost',  // 保持localhost不变，因为数据库服务在EC2实例本地运行
  user: 'root',
  password: '1234',  // 替换为你的实际密码
  database: 'cloud_storage',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

module.exports = pool; 