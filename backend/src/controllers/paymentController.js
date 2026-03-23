const Payment = require('../models/paymentModel');
const { syncPayments, verifyTransaction } = require('../services/stellarService');
const { SCHOOL_WALLET, ACCEPTED_ASSETS } = require('../config/stellarConfig');

// GET /api/payments/instructions/:studentId
async function getPaymentInstructions(req, res) {
  try {
    const { studentId } = req.params;
    res.json({
      walletAddress: SCHOOL_WALLET,
      memo: studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
      note: 'Include the student ID exactly as the memo when sending payment. Only the listed assets are accepted.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/verify
async function verifyPayment(req, res) {
  try {
    const { txHash } = req.body;
    if (!txHash) return res.status(400).json({ error: 'txHash is required' });
    const result = await verifyTransaction(txHash);
    res.json(result);
  } catch (err) {
    const clientErrors = {
      TX_FAILED: 400,
      MISSING_MEMO: 400,
      INVALID_DESTINATION: 400,
      UNSUPPORTED_ASSET: 400,
    };
    const status = clientErrors[err.code] || 500;
    console.error(`[verifyPayment] ${err.code || 'ERROR'}: ${err.message}`);
    res.status(status).json({ error: err.message, code: err.code || 'INTERNAL_ERROR' });
  }
}

// POST /api/payments/sync
async function syncAllPayments(req, res) {
  try {
    await syncPayments();
    res.json({ message: 'Sync complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/:studentId
async function getStudentPayments(req, res) {
  try {
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ confirmedAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/accepted-assets
async function getAcceptedAssets(req, res) {
  try {
    const assets = Object.values(ACCEPTED_ASSETS).map(a => ({
      code: a.code,
      type: a.type,
      displayName: a.displayName,
    }));
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getPaymentInstructions, verifyPayment, syncAllPayments, getStudentPayments, getAcceptedAssets };
