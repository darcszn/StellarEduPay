const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const { syncPayments, verifyTransaction } = require('../services/stellarService');
const { SCHOOL_WALLET, ACCEPTED_ASSETS } = require('../config/stellarConfig');
const crypto = require('crypto');

// Tag errors that originate from Stellar network calls
function wrapStellarError(err) {
  if (!err.code) {
    err.code = 'STELLAR_NETWORK_ERROR';
    err.message = `Stellar network error: ${err.message}`;
  }
  return err;
}

// GET /api/payments/instructions/:studentId
async function getPaymentInstructions(req, res, next) {
  try {
    res.json({
      walletAddress: SCHOOL_WALLET,
      memo: req.params.studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
      note: 'Include the payment intent memo exactly when sending payment to ensure your fees are credited.',
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/intent
async function createPaymentIntent(req, res) {
  try {
    const { studentId } = req.body;
    const student = await Student.findOne({ studentId });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Generate a unique memo for this payment
    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();

    const intent = await PaymentIntent.create({
      studentId,
      amount: student.feeAmount,
      memo,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
    });

    res.status(201).json(intent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/verify
async function verifyPayment(req, res, next) {
  try {
    const { txHash } = req.body;
    if (!txHash) {
      const err = new Error('txHash is required');
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    const existing = await Payment.findOne({ txHash });
    if (existing) {
      const err = new Error(`Transaction ${txHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      return next(err);
    }

    let result;
    try {
      result = await verifyTransaction(txHash);
    } catch (err) {
      const failCodes = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];
      if (failCodes.includes(err.code)) {
        await Payment.create({ studentId: 'unknown', txHash, amount: 0, status: 'failed' }).catch(() => {});
      }
      return next(failCodes.includes(err.code) ? err : wrapStellarError(err));
    }

    await recordPayment({
      studentId: result.memo,
      txHash: result.hash,
      amount: result.amount,
      feeAmount: result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      status: 'confirmed',
      memo: result.memo,
      confirmedAt: new Date(result.date),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/sync
async function syncAllPayments(req, res, next) {
  try {
    await syncPayments();
    res.json({ message: 'Sync complete' });
  } catch (err) {
    next(wrapStellarError(err));
  }
}

// GET /api/payments/:studentId
async function getStudentPayments(req, res, next) {
  try {
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ confirmedAt: -1 });
    res.json(payments);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/accepted-assets
async function getAcceptedAssets(req, res, next) {
  try {
    res.json({
      assets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPaymentInstructions,
  verifyPayment,
  syncAllPayments,
  getStudentPayments,
  getAcceptedAssets,
  createPaymentIntent,
};
