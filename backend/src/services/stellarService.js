'use strict';

const { server, isAcceptedAsset, CONFIRMATION_THRESHOLD } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const FeeStructure = require('../models/feeStructureModel');
const FeeAdjustmentService = require('./feeAdjustmentService');
const SourceValidationRule = require('../models/sourceValidationRuleModel');   // ← #75

const { validatePaymentAmount } = require('../utils/paymentLimits');
const { generateReferenceCode } = require('../utils/generateReferenceCode');

function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === 'native' ? 'XLM' : payOp.asset_code;
  const { accepted } = isAcceptedAsset(assetCode, assetType);
  if (!accepted) return null;
  return { assetCode, assetType, assetIssuer: payOp.asset_issuer };
}

function normalizeAmount(rawAmount) {
  return parseFloat(parseFloat(rawAmount).toFixed(7));
}

/**
 * Validate transaction source account to prevent spoofing (Issue #75)
 */
async function validateSourceAccount(sourceAccount, schoolId, txDate) {
  if (!sourceAccount) {
    return { valid: false, suspicious: true, reason: 'Missing source account' };
  }

  const rules = await SourceValidationRule.find({ isActive: true }).sort({ priority: 1 });

  for (const rule of rules) {
    switch (rule.type) {
      case 'blacklist':
        if (rule.value === sourceAccount) {
          return { valid: false, suspicious: true, reason: `Blacklisted source: ${sourceAccount}` };
        }
        break;

      case 'whitelist':
        if (rule.value !== sourceAccount) {
          return { valid: false, suspicious: true, reason: 'Source account not whitelisted' };
        }
        break;

      case 'pattern':
        if (rule.value && !new RegExp(rule.value).test(sourceAccount)) {
          return { valid: false, suspicious: true, reason: 'Source failed pattern validation' };
        }
        break;

      case 'new_sender_limit':
        const dayStart = new Date(txDate);
        dayStart.setHours(0, 0, 0, 0);

        const count = await Payment.countDocuments({
          schoolId,
          senderAddress: sourceAccount,
          createdAt: { $gte: dayStart }
        });

        if (count >= (rule.maxTransactionsPerDay || 5)) {
          return { valid: false, suspicious: true, reason: `New sender exceeded daily limit (${count})` };
        }
        break;
    }
  }

  return { valid: true, suspicious: false, reason: null };
}

/**
 * Extract valid payment operation
 */
async function extractValidPayment(tx, walletAddress) {
  if (!tx.successful) return null;

  const memo = tx.memo ? tx.memo.trim() : null;
  if (!memo) return null;

  const ops = await tx.operations();
  const payOp = ops.records.find(op => op.type === 'payment' && op.to === walletAddress);
  if (!payOp) return null;

  const asset = detectAsset(payOp);
  if (!asset) return null;

  return { payOp, memo, asset };
}

/**
 * Calculate adjusted fee (from #74)
 */
async function getAdjustedFee(student, intentAmount, paymentDate, schoolId) {
  const feeStructure = await FeeStructure.findOne({
    schoolId,
    className: student.class || student.className,
    academicYear: student.academicYear
  });

  const baseFee = feeStructure ? feeStructure.feeAmount : (student.feeAmount || intentAmount || 0);

  const paymentContext = {
    student,
    academicYear: student.academicYear,
    paymentDate: paymentDate || new Date(),
    baseAmount: baseFee
  };

  const result = await FeeAdjustmentService.calculateAdjustedFee({ feeAmount: baseFee }, paymentContext);

  return {
    baseFee: result.baseFee,
    finalFee: result.finalFee,
    adjustmentsApplied: result.adjustmentsApplied
  };
}

function validatePaymentAgainstFee(paymentAmount, finalFee) {
  if (paymentAmount < finalFee * 0.99) {
    return { status: 'underpaid', excessAmount: 0, message: `Underpaid: ${paymentAmount} < ${finalFee}` };
  }
  if (paymentAmount > finalFee * 1.01) {
    const excess = parseFloat((paymentAmount - finalFee).toFixed(7));
    return { status: 'overpaid', excessAmount: excess, message: `Overpaid by ${excess}` };
  }
  return { status: 'valid', excessAmount: 0, message: 'Payment matches final fee' };
}

async function checkConfirmationStatus(txLedger) {
  const latestLedger = await server.ledgers().order('desc').limit(1).call();
  const latestSequence = latestLedger.records[0].sequence;
  return (latestSequence - txLedger) >= CONFIRMATION_THRESHOLD;
}

async function detectMemoCollision(studentObjId, senderAddress, paymentAmount, finalFee, txDate, schoolId) {
  const COLLISION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const windowStart = new Date(txDate.getTime() - COLLISION_WINDOW_MS);

  const recent = await Payment.findOne({
    schoolId,
    studentId: studentObjId,
    senderAddress: { $ne: senderAddress, $ne: null },
    confirmedAt: { $gte: windowStart }
  });

  if (recent) return { suspicious: true, reason: 'Memo used by different sender within 24h' };
  if (paymentAmount <= 0 || paymentAmount > finalFee * 2) return { suspicious: true, reason: 'Unusual amount vs finalFee' };
  return { suspicious: false, reason: null };
}

async function detectAbnormalPatterns(senderAddress, paymentAmount, finalFee, txDate, schoolId) {
  const RAPID_TX_WINDOW_MS = parseInt(process.env.RAPID_TX_WINDOW_MS, 10) || 10 * 60 * 1000;
  const RAPID_TX_LIMIT = parseInt(process.env.RAPID_TX_LIMIT, 10) || 3;
  const UNUSUAL_MULTIPLIER = parseFloat(process.env.UNUSUAL_AMOUNT_MULTIPLIER) || 3;

  const reasons = [];
  const windowStart = new Date(txDate.getTime() - RAPID_TX_WINDOW_MS);

  if (senderAddress) {
    const count = await Payment.countDocuments({ schoolId, senderAddress, confirmedAt: { $gte: windowStart } });
    if (count >= RAPID_TX_LIMIT) reasons.push('Rapid transactions from sender');
  }

  if (finalFee > 0) {
    const ratio = paymentAmount / finalFee;
    if (ratio > UNUSUAL_MULTIPLIER || ratio < 1 / UNUSUAL_MULTIPLIER) reasons.push('Unusual amount ratio');
  }

  return reasons.length > 0 ? { suspicious: true, reason: reasons.join('; ') } : { suspicious: false, reason: null };
}

/* ====================== MAIN FUNCTIONS ====================== */

async function verifyTransaction(txHash, walletAddress) {
  const tx = await server.transactions().transaction(txHash).call();

  if (!tx.successful) throw Object.assign(new Error('Transaction failed'), { code: 'TX_FAILED' });

  const memo = tx.memo ? tx.memo.trim() : null;
  if (!memo) throw Object.assign(new Error('Missing memo'), { code: 'MISSING_MEMO' });

  const ops = await tx.operations();
  const payOp = ops.records.find(op => op.type === 'payment' && op.to === walletAddress);
  if (!payOp) throw Object.assign(new Error('Invalid destination'), { code: 'INVALID_DESTINATION' });

  const sourceAccount = payOp.from;
  const amount = normalizeAmount(payOp.amount);

  // === #75 Source Validation ===
  const sourceValidation = await validateSourceAccount(sourceAccount, null, new Date(tx.created_at));
  if (!sourceValidation.valid) {
    throw Object.assign(new Error(sourceValidation.reason), { code: 'INVALID_SOURCE' });
  }

  const asset = detectAsset(payOp);
  if (!asset) throw Object.assign(new Error('Unsupported asset'), { code: 'UNSUPPORTED_ASSET' });

  const limitValidation = validatePaymentAmount(amount);
  if (!limitValidation.valid) throw Object.assign(new Error(limitValidation.error), { code: limitValidation.code });

  const student = await Student.findOne({ studentId: memo });
  if (!student) return { status: 'unknown_student', memo, amount };

  const txDate = new Date(tx.created_at);
  const { baseFee, finalFee, adjustmentsApplied } = await getAdjustedFee(student, student.feeAmount, txDate, student.schoolId || null);

  const feeValidation = validatePaymentAgainstFee(amount, finalFee);

  return {
    hash: tx.hash,
    memo,
    studentId: memo,
    amount,
    assetCode: asset.assetCode,
    baseFee,
    finalFee,
    adjustmentsApplied,
    sourceAccount,
    sourceValidation,
    feeValidation,
    date: tx.created_at,
    senderAddress: sourceAccount
  };
}

async function syncPaymentsForSchool(school) {
  const { schoolId, stellarAddress } = school;

  const transactions = await server.transactions()
    .forAccount(stellarAddress)
    .order('desc')
    .limit(20)
    .call();

  for (const tx of transactions.records) {
    if (await Payment.findOne({ txHash: tx.hash })) continue;

    const valid = await extractValidPayment(tx, stellarAddress);
    if (!valid) continue;

    const { payOp, memo } = valid;
    const intent = await PaymentIntent.findOne({ schoolId, memo, status: 'pending' });
    if (!intent) continue;

    const student = await Student.findOne({ schoolId, studentId: intent.studentId });
    if (!student) continue;

    const paymentAmount = parseFloat(payOp.amount);
    const senderAddress = payOp.from || null;
    const txDate = new Date(tx.created_at);
    const txLedger = tx.ledger_attr || tx.ledger || null;

    // === #75 Source Validation ===
    const sourceValidation = await validateSourceAccount(senderAddress, schoolId, txDate);
    if (!sourceValidation.valid) {
      console.warn(`[Source Validation] Rejected tx ${tx.hash} from ${senderAddress}: ${sourceValidation.reason}`);
      continue; // Reject suspicious source
    }

    const { baseFee, finalFee, adjustmentsApplied } = await getAdjustedFee(student, intent.amount, txDate, schoolId);

    const limitValidation = validatePaymentAmount(paymentAmount);
    if (!limitValidation.valid) continue;

    const isConfirmed = txLedger ? await checkConfirmationStatus(txLedger) : false;
    const confirmationStatus = isConfirmed ? 'confirmed' : 'pending_confirmation';

    const [collision, abnormal] = await Promise.all([
      detectMemoCollision(student._id, senderAddress, paymentAmount, finalFee, txDate, schoolId),
      detectAbnormalPatterns(senderAddress, paymentAmount, finalFee, txDate, schoolId)
    ]);

    const isSuspicious = collision.suspicious || abnormal.suspicious || sourceValidation.suspicious;
    const suspicionReason = [collision.reason, abnormal.reason, sourceValidation.reason]
      .filter(Boolean).join('; ') || null;

    const agg = await Payment.aggregate([
      { $match: { schoolId, studentId: student._id, status: 'SUCCESS' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const previousTotal = agg.length ? agg[0].total : 0;
    const cumulativeTotal = parseFloat((previousTotal + paymentAmount).toFixed(7));
    const remainingBalance = Math.max(0, parseFloat((finalFee - cumulativeTotal).toFixed(7)));

    const cumulativeStatus = cumulativeTotal < finalFee ? 'underpaid' : cumulativeTotal > finalFee ? 'overpaid' : 'valid';
    const excessAmount = cumulativeStatus === 'overpaid' ? parseFloat((cumulativeTotal - finalFee).toFixed(7)) : 0;

    const feeValidation = validatePaymentAgainstFee(paymentAmount, finalFee);

    await Payment.create({
      schoolId,
      studentId: student._id,
      studentIdStr: intent.studentId,
      txHash: tx.hash,
      amount: paymentAmount,
      feeAmount: intent.amount,
      baseFee,
      finalFee,
      adjustmentsApplied,
      feeValidationStatus: cumulativeStatus,
      excessAmount,
      status: 'SUCCESS',
      memo,
      senderAddress,
      isSuspicious,
      suspicionReason,
      ledger: txLedger,
      ledgerSequence: txLedger,
      confirmationStatus,
      confirmedAt: txDate,
      referenceCode: await generateReferenceCode()
    });

    if (isConfirmed && !isSuspicious) {
      await Student.findOneAndUpdate(
        { schoolId, studentId: intent.studentId },
        { totalPaid: cumulativeTotal, remainingBalance, feePaid: cumulativeTotal >= finalFee }
      );
    }

    await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'completed' });

    if (['valid', 'overpaid'].includes(feeValidation.status)) {
      await Student.findOneAndUpdate({ schoolId, studentId: intent.studentId }, { feePaid: true });
    }
  }
}

async function finalizeConfirmedPayments(schoolId) {
  const pending = await Payment.find({
    schoolId,
    confirmationStatus: 'pending_confirmation',
    isSuspicious: false
  });

  for (const payment of pending) {
    if (!payment.ledger) continue;
    const isConfirmed = await checkConfirmationStatus(payment.ledger);
    if (!isConfirmed) continue;

    await Payment.findByIdAndUpdate(payment._id, { confirmationStatus: 'confirmed' });

    const student = await Student.findOne({ schoolId, studentId: payment.studentIdStr });
    if (!student) continue;

    const agg = await Payment.aggregate([
      { $match: { schoolId, studentId: payment.studentId, confirmationStatus: 'confirmed', isSuspicious: false } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const totalPaid = agg.length ? parseFloat(agg[0].total.toFixed(7)) : 0;
    const remainingBalance = Math.max(0, parseFloat((payment.finalFee - totalPaid).toFixed(7)));

    await Student.findOneAndUpdate(
      { schoolId, studentId: payment.studentIdStr },
      { totalPaid, remainingBalance, feePaid: totalPaid >= payment.finalFee }
    );
  }
}

module.exports = {
  syncPaymentsForSchool,
  verifyTransaction,
  extractValidPayment,
  detectAsset,
  normalizeAmount,
  checkConfirmationStatus,
  finalizeConfirmedPayments,
  validatePaymentAgainstFee
};