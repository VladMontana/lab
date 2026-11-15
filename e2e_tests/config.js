// e2e_tests/config.js

export const config = {
  baseUrl: process.env.TEST_BASE_URL || 'http://127.0.0.1:8080',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin_test_password_123',
  testTimeout: parseInt(process.env.TEST_TIMEOUT || '10000', 10),
  healthCheckTimeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '30000', 10),
};
