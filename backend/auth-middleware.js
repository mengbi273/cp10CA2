// 简化的认证中间件，直接使用测试用户
const authenticateToken = (req, res, next) => {
  // 为测试目的，总是使用一个测试用户ID
  req.user = { id: 1, username: 'testuser' };
  next();
};

module.exports = {
  authenticateToken
}; 