// Test runs always target a dedicated database; they never read backend/.env.
process.env.DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.TEST_DB_PORT || '5432';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'laith_erp_test';
process.env.DB_USER = process.env.TEST_DB_USER || 'erp';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'erp_dev_pw';
process.env.DB_SSL = 'false';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123';
process.env.UPLOAD_DIR = process.env.TEST_UPLOAD_DIR || '/tmp/laith-erp-test-uploads';
process.env.DISABLE_BACKGROUND_JOBS = 'true';
process.env.DATA_ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
