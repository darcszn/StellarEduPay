require('dotenv').config();
const config = require('./config');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const studentRoutes = require('./routes/studentRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const feeRoutes = require('./routes/feeRoutes');
const reportRoutes = require('./routes/reportRoutes');
const { startPolling } = require('./services/transactionService');
const { startRetryWorker } = require('./services/retryService');

const app = express();

app.use(cors());
app.use(express.json());

// ── Request timeout ───────────────────────────────────────────────────────────
// If a response has not been sent within REQUEST_TIMEOUT_MS, reply 503.
app.use((req, res, next) => {
  res.setTimeout(config.REQUEST_TIMEOUT_MS, () => {
    const err = new Error(`Request timed out after ${config.REQUEST_TIMEOUT_MS}ms`);
    err.code = 'REQUEST_TIMEOUT';
    next(err);
  });
  next();
});

mongoose.connect(config.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    startPolling();
    startRetryWorker();
  })
  .catch(err => console.error('MongoDB error:', err));

app.use('/api/students', studentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/reports', reportRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Global error handler — all controllers forward errors here via next(err)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const statusMap = {
    TX_FAILED: 400,
    MISSING_MEMO: 400,
    INVALID_DESTINATION: 400,
    UNSUPPORTED_ASSET: 400,
    DUPLICATE_TX: 409,
    NOT_FOUND: 404,
    VALIDATION_ERROR: 400,
    STELLAR_NETWORK_ERROR: 502,
    REQUEST_TIMEOUT: 503,
  };
  const status = statusMap[err.code] || err.status || 500;
  console.error(`[${err.code || 'ERROR'}] ${err.message}`);
  res.status(status).json({ error: err.message, code: err.code || 'INTERNAL_ERROR' });
});

const PORT = config.PORT;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
