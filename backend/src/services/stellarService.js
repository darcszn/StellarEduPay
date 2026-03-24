const { server, SCHOOL_WALLET, isAcceptedAsset } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');

/**
 * Detect asset information from a Stellar payment operation.
 * Returns { assetCode, assetType, assetIssuer } or null if unsupported.
 */
function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === 'native' ? 'XLM' : payOp.asset_code;
  const assetIssuer = assetType === 'native' ? null : payOp.asset_issuer;

  const { accepted } = isAcceptedAsset(assetCode, assetType);
  if (!accepted) return null;

  return { assetCode, assetType, assetIssuer };
}

/**
 * Normalize a raw amount string to a number with consistent precision.
 */
function normalizeAmount(rawAmount) {
  return parseFloat(parseFloat(rawAmount).toFixed(7));
}

// Fetch recent transactions to the school wallet and record new payments
async function syncPayments() {
  const transactions = await server
    .transactions()
    .forAccount(SCHOOL_WALLET)
    .order('desc')
    .limit(20)
    .call();

  for (const tx of transactions.records) {
    const memo = tx.memo;
    if (!memo) continue;

    const exists = await Payment.findOne({ txHash: tx.hash });
    if (exists) continue;

    const ops = await tx.operations();
    const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
    if (!payOp) continue;

    // Detect asset type and reject unsupported assets
    const asset = detectAsset(payOp);
    if (!asset) continue; // skip unsupported assets

    const student = await Student.findOne({ studentId: memo });
    if (!student) continue;

    const paymentAmount = parseFloat(payOp.amount);

    // Aggregate all previous payments for this student
    const previousPayments = await Payment.aggregate([
      { $match: { studentId: memo } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const previousTotal = previousPayments.length ? previousPayments[0].total : 0;
    const cumulativeTotal = parseFloat((previousTotal + paymentAmount).toFixed(7));
    const remaining = parseFloat((student.feeAmount - cumulativeTotal).toFixed(7));

    // Determine cumulative validation status
    let cumulativeStatus;
    if (cumulativeTotal < student.feeAmount) {
      cumulativeStatus = 'underpaid';
    } else if (cumulativeTotal > student.feeAmount) {
      cumulativeStatus = 'overpaid';
    } else {
      cumulativeStatus = 'valid';
    }

    const excessAmount = cumulativeStatus === 'overpaid'
      ? parseFloat((cumulativeTotal - student.feeAmount).toFixed(7))
      : 0;

    await Payment.create({
      studentId: memo,
      txHash: tx.hash,
      amount: paymentAmount,
      feeAmount: student.feeAmount,
      feeValidationStatus: cumulativeStatus,
      excessAmount,
      memo,
      confirmedAt: new Date(tx.created_at),
    });

    // Update student's running totals
    await Student.findOneAndUpdate(
      { studentId: memo },
      {
        totalPaid: cumulativeTotal,
        remainingBalance: remaining < 0 ? 0 : remaining,
        feePaid: cumulativeTotal >= student.feeAmount,
      }
    );
  }
}

// Verify a single transaction hash against the school wallet
async function verifyTransaction(txHash) {
  const tx = await server.transactions().transaction(txHash).call();
  const ops = await tx.operations();
  const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
  if (!payOp) return null;

  const amount = parseFloat(payOp.amount);

  // Look up the student to validate against their fee
  const student = await Student.findOne({ studentId: tx.memo });
  const feeAmount = student ? student.feeAmount : null;
  const feeValidation = feeAmount != null
    ? validatePaymentAgainstFee(amount, feeAmount)
    : { status: 'unknown', message: 'Student not found, cannot validate fee' };

  return {
    hash: tx.hash,
    memo: tx.memo,
    amount,
    feeAmount,
    feeValidation,
    date: tx.created_at,
  };
}

/**
 * Validate a payment amount against the expected fee.
 * @param {number} paymentAmount — the amount actually paid
 * @param {number} expectedFee — the fee the student owes
 * @returns {{ status: string, message: string }}
 */
function validatePaymentAgainstFee(paymentAmount, expectedFee) {
  if (paymentAmount < expectedFee) {
    return {
      status: 'underpaid',
      excessAmount: 0,
      message: `Payment of ${paymentAmount} is less than the required fee of ${expectedFee}`,
    };
  }
  if (paymentAmount > expectedFee) {
    const excess = parseFloat((paymentAmount - expectedFee).toFixed(7));
    return {
      status: 'overpaid',
      excessAmount: excess,
      message: `Payment of ${paymentAmount} exceeds the required fee of ${expectedFee} by ${excess}`,
    };
  }
  return {
    status: 'valid',
    excessAmount: 0,
    message: 'Payment matches the required fee',
  };
}

module.exports = { syncPayments, verifyTransaction, validatePaymentAgainstFee };
