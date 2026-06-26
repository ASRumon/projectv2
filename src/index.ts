/**
 * QueueStorm Investigator Worker
 * Complaint investigation copilot for digital finance platforms
 * https://developers.cloudflare.com/workers/
 */

import type {
  AnalyzeTicketRequest,
  AnalyzeTicketResponse,
  TransactionHistoryItem,
  TransactionMatchScore,
  EvidenceVerdict,
  CaseType,
  Severity,
  Department,
  Language,
  Env,
  AnalysisContext,
} from './types';

// ============================================================================
// TRANSACTION MATCHING LOGIC
// ============================================================================

interface MatchableAmount {
  value: number;
  position: number;
  context: string;
}

/**
 * Extract potential amounts mentioned in complaint text
 */
function extractMentionedAmounts(text: string): MatchableAmount[] {
  const amounts: MatchableAmount[] = [];

  // Pattern 1: "5000 taka" or "5000 tk" or just "5000" followed by optional currency
  const amountPatterns = [
    /(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(?:taka|tk|BDT|৳)?/gi,
    /(\d+(?:,\d{3})*(?:\.\d{2})?)/g,
  ];

  for (const pattern of amountPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseInt(match[1].replace(/,/g, ''), 10);
      // Reasonable amounts for digital finance (100 to 10M)
      if (value >= 100 && value <= 10000000) {
        amounts.push({
          value,
          position: match.index,
          context: text.substring(Math.max(0, match.index - 20), match.index + match[0].length + 20),
        });
      }
    }
  }

  return amounts;
}

/**
 * Extract time/date mentioned in complaint
 */
function extractMentionedTimes(text: string, comparisonDate: Date): Date[] {
  const times: Date[] = [];

  // Pattern: "2pm", "2:30pm", "14:00", "14:30", "around 2", "about 2 hours ago"
  const timePatterns = [
    /(\d{1,2}):?(\d{2})?\s*(?:am|pm|AM|PM)/gi,
    /(morning|afternoon|evening|noon|midnight)/gi,
    /(\d+)\s*(?:hours?|minutes?|hrs?|mins?)\s*ago/gi,
  ];

  for (const pattern of timePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      try {
        if (match[1] && /\d/.test(match[1])) {
          const hour = parseInt(match[1], 10);
          const minute = match[2] ? parseInt(match[2], 10) : 0;
          const isPM = /pm/i.test(text.substring(match.index, match.index + match[0].length + 5));

          const date = new Date(comparisonDate);
          date.setHours(isPM && hour !== 12 ? hour + 12 : hour, minute, 0, 0);
          times.push(date);
        }
      } catch (e) {
        // Skip malformed times
      }
    }
  }

  return times;
}

/**
 * Score a transaction based on multiple criteria
 */
function scoreTransaction(
  txn: TransactionHistoryItem,
  complaint: string,
  mentionedAmounts: MatchableAmount[],
  mentionedTimes: Date[],
): number {
  let score = 0;
  const reasons: string[] = [];

  // Amount matching (exact match is 40 points)
  for (const ma of mentionedAmounts) {
    if (ma.value === txn.amount) {
      score += 40;
      reasons.push(`amount_match_${txn.amount}`);
      break;
    }
  }

  // Time matching (within 1 hour is 25 points)
  if (mentionedTimes.length > 0) {
    const txnTime = new Date(txn.timestamp);
    for (const mt of mentionedTimes) {
      const diffMs = Math.abs(txnTime.getTime() - mt.getTime());
      const diffHours = diffMs / (1000 * 60 * 60);
      if (diffHours <= 1) {
        score += 25;
        reasons.push(`time_match_${diffHours.toFixed(2)}h`);
        break;
      }
    }
  }

  // Transaction type hints
  const complaintLower = complaint.toLowerCase();
  if (
    txn.type === 'transfer' &&
    (complaintLower.includes('transfer') ||
      complaintLower.includes('send') ||
      complaintLower.includes('sent') ||
      complaintLower.includes('number'))
  ) {
    score += 15;
    reasons.push('type_transfer_mentioned');
  }

  if (
    txn.type === 'payment' &&
    (complaintLower.includes('payment') ||
      complaintLower.includes('pay') ||
      complaintLower.includes('paid') ||
      complaintLower.includes('bill'))
  ) {
    score += 15;
    reasons.push('type_payment_mentioned');
  }

  if (
    txn.type === 'cash_in' &&
    (complaintLower.includes('cash') ||
      complaintLower.includes('agent') ||
      complaintLower.includes('deposit'))
  ) {
    score += 15;
    reasons.push('type_cashIn_mentioned');
  }

  if (
    txn.type === 'settlement' &&
    (complaintLower.includes('settlement') ||
      complaintLower.includes('settle') ||
      complaintLower.includes('merchant') ||
      complaintLower.includes('sale'))
  ) {
    score += 15;
    reasons.push('type_settlement_mentioned');
  }

  // Counterparty matching (phone numbers, merchant IDs, agent IDs)
  if (txn.counterparty && txn.counterparty.length > 0) {
    if (complaint.includes(txn.counterparty)) {
      score += 20;
      reasons.push(`counterparty_match_${txn.counterparty}`);
    }
  }

  // Status bonus for completed transactions (they're more likely relevant for complaints)
  if (txn.status === 'completed') {
    score += 5;
  }

  // Penalty for failed/reversed transactions in general cases (but bonus for failed payment complaints)
  if ((txn.status === 'failed' || txn.status === 'reversed') && complaintLower.includes('fail')) {
    score += 10;
    reasons.push('failed_status_matches_complaint');
  }

  return score;
}

/**
 * Find the most relevant transaction
 */
function findRelevantTransaction(
  complaint: string,
  history: TransactionHistoryItem[],
): { txn: TransactionHistoryItem | null; score: number; scores: TransactionMatchScore[] } {
  if (!history || history.length === 0) {
    return { txn: null, score: 0, scores: [] };
  }

  const comparisonDate = new Date(); // Use current date as reference
  const amounts = extractMentionedAmounts(complaint);
  const times = extractMentionedTimes(complaint, comparisonDate);

  const scores: TransactionMatchScore[] = history.map((txn) => ({
    transactionId: txn.transaction_id,
    score: scoreTransaction(txn, complaint, amounts, times),
    reasons: [],
  }));

  // Re-score to get reasons
  for (let i = 0; i < history.length; i++) {
    let score = 0;
    const reasons: string[] = [];

    // Re-compute with reasons
    for (const ma of amounts) {
      if (ma.value === history[i].amount) {
        score += 40;
        reasons.push(`amount_match_${history[i].amount}`);
        break;
      }
    }

    if (times.length > 0) {
      const txnTime = new Date(history[i].timestamp);
      for (const mt of times) {
        const diffMs = Math.abs(txnTime.getTime() - mt.getTime());
        const diffHours = diffMs / (1000 * 60 * 60);
        if (diffHours <= 1) {
          score += 25;
          reasons.push(`time_match_${diffHours.toFixed(2)}h`);
          break;
        }
      }
    }

    scores[i].score = score;
    scores[i].reasons = reasons;
  }

  const best = scores.reduce((a, b) => (a.score > b.score ? a : b));

  if (best.score < 10) {
    // Threshold: at least some evidence of relevance
    return { txn: null, score: 0, scores };
  }

  const txn = history.find((t) => t.transaction_id === best.transactionId) || null;
  return { txn, score: best.score, scores };
}

// ============================================================================
// EVIDENCE VERDICT LOGIC
// ============================================================================

/**
 * Determine if complaint evidence is consistent, inconsistent, or insufficient
 */
function determineEvidenceVerdict(
  complaint: string,
  txn: TransactionHistoryItem | null,
  history: TransactionHistoryItem[],
): {
  verdict: EvidenceVerdict;
  reasoning: string;
} {
  if (!txn) {
    return {
      verdict: 'insufficient_data',
      reasoning: 'No matching transaction found',
    };
  }

  const complaintLower = complaint.toLowerCase();

  // If transaction is failed, and complaint mentions failure, it's consistent
  if (txn.status === 'failed' && complaintLower.includes('fail')) {
    return {
      verdict: 'consistent',
      reasoning: 'Transaction status is failed, complaint mentions failure',
    };
  }

  // If complaint is about money not being received, and transaction is pending, it's consistent
  if (
    (txn.status === 'pending' ||
      complaintLower.includes('not received') ||
      complaintLower.includes('didn\'t get') ||
      complaintLower.includes('not reflecting') ||
      complaintLower.includes('not settled')) &&
    txn.status === 'pending'
  ) {
    return {
      verdict: 'consistent',
      reasoning: 'Transaction status is pending, complaint indicates non-receipt',
    };
  }

  // If same counterparty has many prior transfers, and customer claims "wrong transfer", it's inconsistent
  if (complaintLower.includes('wrong') || complaintLower.includes('mistake')) {
    const sameCounterpartyCount = history.filter(
      (h) => h.counterparty === txn.counterparty && h.status === 'completed',
    ).length;

    if (sameCounterpartyCount >= 3) {
      return {
        verdict: 'inconsistent',
        reasoning: `Multiple prior completed transfers to same recipient (${sameCounterpartyCount}) contradicts wrong transfer claim`,
      };
    }

    if (sameCounterpartyCount >= 1) {
      return {
        verdict: 'inconsistent',
        reasoning: 'Prior transfer to same recipient suggests established recipient',
      };
    }
  }

  // Duplicate payment check
  if (complaintLower.includes('duplicate') || complaintLower.includes('deducted twice')) {
    const similarTxns = history.filter(
      (h) => h.amount === txn.amount && h.counterparty === txn.counterparty && h.type === txn.type,
    );

    if (similarTxns.length >= 2) {
      return {
        verdict: 'consistent',
        reasoning: 'Multiple identical transactions to same counterparty indicate duplicate',
      };
    }
  }

  // If complaint mentions amount and time, and they match, it's consistent
  if (
    extractMentionedAmounts(complaint).some((a) => a.value === txn.amount) &&
    extractMentionedTimes(complaint, new Date()).length > 0
  ) {
    return {
      verdict: 'consistent',
      reasoning: 'Complaint amount and transaction match',
    };
  }

  // If transaction is completed and complaint doesn't contradict it
  if (txn.status === 'completed') {
    return {
      verdict: 'consistent',
      reasoning: 'Transaction completed as per complaint description',
    };
  }

  return {
    verdict: 'insufficient_data',
    reasoning: 'Insufficient evidence to determine consistency',
  };
}

// ============================================================================
// CASE CLASSIFICATION
// ============================================================================

function classifyCase(
  complaint: string,
  txn: TransactionHistoryItem | null,
  verdict: EvidenceVerdict,
  history: TransactionHistoryItem[],
): {
  caseType: CaseType;
  confidence: number;
} {
  const complaintLower = complaint.toLowerCase();

  // Phishing/Social Engineering: never requires transaction
  if (
    complaintLower.includes('otp') ||
    complaintLower.includes('pin') ||
    complaintLower.includes('password') ||
    complaintLower.includes('phishing') ||
    complaintLower.includes('scam') ||
    complaintLower.includes('called') ||
    (complaintLower.includes('claim') && complaintLower.includes('account') && complaintLower.includes('block'))
  ) {
    return {
      caseType: 'phishing_or_social_engineering',
      confidence: 0.95,
    };
  }

  // If no transaction found
  if (!txn) {
    if (
      complaintLower.includes('transfer') ||
      complaintLower.includes('sent') ||
      complaintLower.includes('send')
    ) {
      return { caseType: 'wrong_transfer', confidence: 0.5 };
    }
    return { caseType: 'other', confidence: 0.3 };
  }

  // Payment failed
  if (
    txn.type === 'payment' &&
    txn.status === 'failed' &&
    (complaintLower.includes('fail') || complaintLower.includes('deducted'))
  ) {
    return {
      caseType: 'payment_failed',
      confidence: 0.95,
    };
  }

  // Duplicate payment
  if (
    (txn.type === 'payment' || txn.type === 'transfer') &&
    (complaintLower.includes('duplicate') ||
      complaintLower.includes('deducted twice') ||
      complaintLower.includes('charged twice'))
  ) {
    const similarTxns = history.filter(
      (h) =>
        h.amount === txn.amount &&
        h.counterparty === txn.counterparty &&
        h.status === 'completed' &&
        Math.abs(new Date(h.timestamp).getTime() - new Date(txn.timestamp).getTime()) < 60000, // within 1 minute
    );

    if (similarTxns.length >= 2) {
      return {
        caseType: 'duplicate_payment',
        confidence: 0.95,
      };
    }

    return {
      caseType: 'duplicate_payment',
      confidence: 0.7,
    };
  }

  // Refund request
  if (
    txn.type === 'payment' &&
    (complaintLower.includes('refund') ||
      complaintLower.includes('changed mind') ||
      complaintLower.includes('don\'t want') ||
      complaintLower.includes('changed my mind'))
  ) {
    return {
      caseType: 'refund_request',
      confidence: 0.9,
    };
  }

  // Wrong transfer
  if (
    txn.type === 'transfer' &&
    (complaintLower.includes('wrong') ||
      complaintLower.includes('mistake') ||
      complaintLower.includes('wrong number') ||
      complaintLower.includes('wrong person') ||
      (complaintLower.includes('didn\'t get') || complaintLower.includes('not received')))
  ) {
    return {
      caseType: 'wrong_transfer',
      confidence: 0.85,
    };
  }

  // Agent cash-in issue
  if (
    txn.type === 'cash_in' &&
    (txn.status === 'pending' ||
      (complaintLower.includes('agent') && complaintLower.includes('cash')))
  ) {
    return {
      caseType: 'agent_cash_in_issue',
      confidence: 0.9,
    };
  }

  // Merchant settlement delay
  if (
    txn.type === 'settlement' &&
    (txn.status === 'pending' || complaintLower.includes('settlement'))
  ) {
    return {
      caseType: 'merchant_settlement_delay',
      confidence: 0.9,
    };
  }

  return {
    caseType: 'other',
    confidence: 0.5,
  };
}

// ============================================================================
// SEVERITY ASSIGNMENT
// ============================================================================

function assignSeverity(
  caseType: CaseType,
  verdict: EvidenceVerdict,
  txn: TransactionHistoryItem | null,
): Severity {
  // Critical cases
  if (caseType === 'phishing_or_social_engineering') {
    return 'critical';
  }

  // High severity
  if (
    (caseType === 'wrong_transfer' && verdict === 'consistent') ||
    (caseType === 'payment_failed' && txn && txn.status === 'failed') ||
    (caseType === 'duplicate_payment' && verdict === 'consistent') ||
    (caseType === 'agent_cash_in_issue' && txn && txn.status === 'pending')
  ) {
    return 'high';
  }

  // Medium severity
  if (
    (caseType === 'wrong_transfer' && verdict === 'inconsistent') ||
    (caseType === 'merchant_settlement_delay') ||
    (caseType === 'payment_failed' && verdict === 'insufficient_data')
  ) {
    return 'medium';
  }

  // Low severity
  if (caseType === 'refund_request' || caseType === 'other') {
    return 'low';
  }

  return 'low';
}

// ============================================================================
// DEPARTMENT ROUTING
// ============================================================================

function routeToDepartment(
  caseType: CaseType,
  userType: string,
): Department {
  if (caseType === 'phishing_or_social_engineering') {
    return 'fraud_risk';
  }

  if (caseType === 'wrong_transfer') {
    return 'dispute_resolution';
  }

  if (caseType === 'payment_failed' || caseType === 'duplicate_payment') {
    return 'payments_ops';
  }

  if (caseType === 'refund_request') {
    return 'customer_support';
  }

  if (caseType === 'agent_cash_in_issue') {
    return 'agent_operations';
  }

  if (caseType === 'merchant_settlement_delay') {
    return 'merchant_operations';
  }

  return 'customer_support';
}

// ============================================================================
// SAFE REPLY GENERATION WITH CLOUDFLARE AI
// ============================================================================

/**
 * Generate a safe customer reply using Cloudflare AI with fallback to rules
 */
async function generateSafeReply(
  complaint: string,
  caseType: CaseType,
  txn: TransactionHistoryItem | null,
  language: Language,
  env: Env,
): Promise<string> {
  const txnId = txn?.transaction_id || 'N/A';

  // Template responses that are always safe
  const safeTemplates: Record<CaseType, Record<Language, string>> = {
    phishing_or_social_engineering: {
      en: `Thank you for reaching out before sharing any information. We never ask for your PIN, OTP, or password under any circumstances. Please do not share these with anyone, even if they claim to be from us. Our fraud team has been notified of this incident.`,
      bn: `আমাদের সাথে যোগাযোগ করার আগে তথ্য শেয়ার না করার জন্য ধন্যবাদ। আমরা কখনই আপনার পিন, ওটিপি বা পাসওয়ার্ড চাই না। কাউকে এই তথ্য শেয়ার করবেন না। আমাদের ফ্রড টিম এই ঘটনা সম্পর্কে অবগত হয়েছে।`,
      mixed: `Thank you for reaching out before sharing any information. আমরা কখনই আপনার পিন, ওটিপি বা পাসওয়ার্ড চাই না। Do not share these with anyone. Our fraud team has been notified.`,
    },
    wrong_transfer: {
      en: `We have noted your concern about transaction ${txnId}. Please do not share your PIN or OTP with anyone. Our dispute team will review the case and contact you through official support channels.`,
      bn: `আমরা আপনার লেনদেন ${txnId} সম্পর্কে অবগত হয়েছি। অনুগ্রহ করে কারো সাথে আপনার পিন বা ওটিপি শেয়ার করবেন না। আমাদের ডিসপিউট টিম এটি পর্যালোচনা করবে এবং অফিসিয়াল চ্যানেলে যোগাযোগ করবে।`,
      mixed: `We have noted your concern about transaction ${txnId}. অনুগ্রহ করে কারো সাথে আপনার পিন শেয়ার করবেন না। Our team will review and contact you soon.`,
    },
    payment_failed: {
      en: `We have noted that transaction ${txnId} may have caused an unexpected balance deduction. Our payments team will review the case and any eligible amount will be returned through official channels. Please do not share your PIN or OTP with anyone.`,
      bn: `আমরা লক্ষ্য করেছি যে লেনদেন ${txnId} ভারসাম্য হ্রাস করতে পারে। আমাদের পেমেন্ট টিম পর্যালোচনা করবে এবং যোগ্য পরিমাণ ফেরত দেওয়া হবে। আপনার পিন শেয়ার করবেন না।`,
      mixed: `We have noted transaction ${txnId}. আমাদের টিম পর্যালোচনা করবে। Any eligible amount will be returned through official channels.`,
    },
    duplicate_payment: {
      en: `We have noted the possible duplicate payment for transaction ${txnId}. Our payments team will verify with the biller and any eligible amount will be returned through official channels. Please do not share your PIN or OTP with anyone.`,
      bn: `আমরা সম্ভাব্য ডুপ্লিকেট পেমেন্ট লেনদেন ${txnId} সম্পর্কে অবগত হয়েছি। আমাদের টিম যাচাই করবে এবং যোগ্য পরিমাণ ফেরত দেওয়া হবে। আপনার পিন শেয়ার করবেন না।`,
      mixed: `We have noted the possible duplicate payment ${txnId}. আমাদের টিম যাচাই করবে। Any eligible amount will be returned through official channels.`,
    },
    refund_request: {
      en: `Thank you for reaching out. Refunds for completed merchant payments depend on the merchant's own policy. We recommend contacting the merchant directly. If you need help reaching them, please reply and we will guide you. Please do not share your PIN or OTP with anyone.`,
      bn: `আপনার অনুসন্ধানের জন্য ধন্যবাদ। রিফান্ড বণিকের নীতির উপর নির্ভর করে। আমরা সুপারিশ করি সরাসরি বণিকের সাথে যোগাযোগ করুন। আপনার পিন শেয়ার করবেন না।`,
      mixed: `Thank you for reaching out. Refunds depend on the merchant's policy. আমরা সুপারিশ করি বণিকের সাথে যোগাযোগ করুন। Do not share your PIN with anyone.`,
    },
    agent_cash_in_issue: {
      en: `We have noted your concern about transaction ${txnId}. Our agent operations team will investigate and contact you through official channels. Please do not share your PIN or OTP with anyone.`,
      bn: `আমরা আপনার লেনদেন ${txnId} সম্পর্কে অবগত হয়েছি। আমাদের এজেন্ট টিম তদন্ত করবে এবং অফিসিয়াল চ্যানেলে যোগাযোগ করবে। আপনার পিন শেয়ার করবেন না।`,
      mixed: `We have noted your concern about transaction ${txnId}. আমাদের টিম তদন্ত করবে। Please do not share your PIN with anyone.`,
    },
    merchant_settlement_delay: {
      en: `We have noted your concern about settlement ${txnId}. Our merchant operations team will check the batch status and update you on the expected settlement time through official channels.`,
      bn: `আমরা আপনার সেটেলমেন্ট ${txnId} সম্পর্কে অবগত হয়েছি। আমাদের মার্চেন্ট টিম ব্যাচ স্ট্যাটাস পরীক্ষা করবে এবং আপডেট করবে।`,
      mixed: `We have noted your settlement ${txnId}. আমাদের টিম স্ট্যাটাস পরীক্ষা করবে। You will be updated through official channels.`,
    },
    other: {
      en: `Thank you for reaching out. To help you faster, please share more details: which transaction, what amount, and what went wrong. Please do not share your PIN or OTP with anyone.`,
      bn: `আপনার অনুসন্ধানের জন্য ধন্যবাদ। আরও বিস্তারিত শেয়ার করুন যাতে আমরা দ্রুত সাহায্য করতে পারি। আপনার পিন শেয়ার করবেন না।`,
      mixed: `Thank you for reaching out. আরও বিস্তারিত শেয়ার করুন। Please do not share your PIN or OTP with anyone.`,
    },
  };

  // Select template based on language fallback
  let template = safeTemplates[caseType]?.[language];
  if (!template && language === 'mixed') {
    template = safeTemplates[caseType]?.['en'];
  }
  if (!template) {
    template = safeTemplates[caseType]?.['en'] || safeTemplates['other']['en'];
  }

  // If AI is available and configured, try to use it for enhancement
  if (env.AI) {
    try {
      const aiPrompt = `You are a customer service assistant for a digital finance platform. 
Generate a brief, safe customer reply to this complaint. 
NEVER mention refunds, reversals, or account unblocks as a promise.
NEVER ask for PIN, OTP, password, or card numbers.
ALWAYS direct to official support channels.
Keep it under 2 sentences.
Complaint: "${complaint}"
Case Type: ${caseType}
Transaction ID: ${txnId}
Language: ${language}

Safe template to improve: "${template}"

Generate a friendly but safe response:`;

      const response = await env.AI.run('@cf/mistral/mistral-7b-instruct-v0.1', {
        prompt: aiPrompt,
        max_tokens: 150,
      });

      if (response && typeof response === 'object') {
        const text =
          'result' in response && typeof response.result === 'string'
            ? response.result
            : 'response' in response && typeof response.response === 'string'
              ? response.response
              : null;

        if (text && text.length > 10) {
          // Validate response doesn't violate safety rules
          const lowerText = text.toLowerCase();
          if (
            !lowerText.includes('refund') &&
            !lowerText.includes('otp') &&
            !lowerText.includes('pin') &&
            !lowerText.includes('password')
          ) {
            return text.trim();
          }
        }
      }
    } catch (error) {
      // Fallback to template if AI fails
      console.warn('AI generation failed, using template:', error);
    }
  }

  return template;
}

// ============================================================================
// SUMMARY AND NEXT ACTION GENERATION
// ============================================================================

function generateAgentSummary(
  complaint: string,
  txn: TransactionHistoryItem | null,
  caseType: CaseType,
  verdict: EvidenceVerdict,
): string {
  if (!txn) {
    return `Customer reports: ${complaint.substring(0, 120)}${complaint.length > 120 ? '...' : ''}`;
  }

  const txnDesc = `${txn.type} of ${txn.amount} BDT to ${txn.counterparty} at ${new Date(txn.timestamp).toLocaleString()}`;

  return `Customer reports issue with transaction ${txn.transaction_id} (${txnDesc}). Status: ${txn.status}. Evidence: ${verdict}. Details: ${complaint.substring(0, 100)}...`;
}

function generateRecommendedNextAction(
  caseType: CaseType,
  department: Department,
  severity: Severity,
  txn: TransactionHistoryItem | null,
  humanReviewRequired: boolean,
): string {
  const actionMap: Record<CaseType, string> = {
    phishing_or_social_engineering:
      'Escalate to fraud_risk team immediately. Confirm customer credential safety. Log reported number for fraud pattern analysis.',
    wrong_transfer:
      'Verify transaction details with customer and initiate the wrong-transfer dispute workflow per policy.',
    payment_failed:
      'Investigate ledger status. If balance was deducted on failed payment, initiate automatic reversal flow within standard SLA.',
    duplicate_payment:
      'Verify duplicate with payments_ops. If biller confirms only one receipt, initiate reversal of the suspected duplicate.',
    refund_request:
      'Inform customer that refund eligibility depends on merchant policy. Provide guidance on contacting merchant directly.',
    agent_cash_in_issue:
      'Investigate pending cash-in transaction status with agent operations. Confirm settlement state and resolve within standard cash-in SLA.',
    merchant_settlement_delay:
      'Route to merchant_operations to verify settlement batch status. If delayed, communicate revised ETA to merchant.',
    other: 'Request clarification from customer about specific transaction, amount, and issue details.',
  };

  return actionMap[caseType] || actionMap['other'];
}

// ============================================================================
// MAIN ANALYZE FUNCTION
// ============================================================================

async function analyzeTicket(
  request: AnalyzeTicketRequest,
  env: Env,
): Promise<AnalyzeTicketResponse> {
  const {
    ticket_id: ticketId,
    complaint,
    language = 'en',
    channel = 'in_app_chat',
    user_type: userType = 'customer',
    transaction_history: transactionHistory = [],
  } = request;

  // Validate required fields
  if (!ticketId || !complaint || complaint.trim().length === 0) {
    throw new Error('Missing required fields: ticket_id and complaint');
  }

  // Find relevant transaction
  const { txn: relevantTxn, score: matchScore, scores } = findRelevantTransaction(complaint, transactionHistory);

  // Determine evidence verdict
  const { verdict } = determineEvidenceVerdict(complaint, relevantTxn, transactionHistory);

  // Classify case
  const { caseType, confidence: classificationConfidence } = classifyCase(
    complaint,
    relevantTxn,
    verdict,
    transactionHistory,
  );

  // Assign severity
  const severity = assignSeverity(caseType, verdict, relevantTxn);

  // Route to department
  const department = routeToDepartment(caseType, userType);

  // Generate safe reply
  const customerReply = await generateSafeReply(complaint, caseType, relevantTxn, language, env);

  // Generate agent summary
  const agentSummary = generateAgentSummary(complaint, relevantTxn, caseType, verdict);

  // Generate recommended next action
  const recommendedNextAction = generateRecommendedNextAction(
    caseType,
    department,
    severity,
    relevantTxn,
    false, // Will set below
  );

  // Determine if human review is required
  const humanReviewRequired: boolean =
    severity === 'critical' ||
    severity === 'high' ||
    (verdict === 'inconsistent' && matchScore > 0) ||
    !!(relevantTxn && relevantTxn.status === 'pending') ||
    caseType === 'phishing_or_social_engineering' ||
    (caseType === 'wrong_transfer' && verdict === 'consistent') ||
    caseType === 'duplicate_payment' ||
    !!(relevantTxn && relevantTxn.status === 'failed' && caseType === 'payment_failed');

  // Determine overall confidence
  const overallConfidence = Math.min(
    1.0,
    (classificationConfidence + Math.min(1.0, matchScore / 50)) / 2,
  );

  // Reason codes
  const reasonCodes: string[] = [];
  if (matchScore > 0) reasonCodes.push('transaction_matched');
  if (verdict === 'consistent') reasonCodes.push('evidence_consistent');
  if (verdict === 'inconsistent') reasonCodes.push('evidence_inconsistent');
  if (humanReviewRequired) reasonCodes.push('human_review_needed');
  if (relevantTxn?.status === 'pending') reasonCodes.push('pending_status');
  reasonCodes.push(caseType);

  return {
    ticket_id: ticketId,
    relevant_transaction_id: relevantTxn?.transaction_id ?? null,
    evidence_verdict: verdict,
    case_type: caseType,
    severity,
    department,
    agent_summary: agentSummary,
    recommended_next_action: recommendedNextAction,
    customer_reply: customerReply,
    human_review_required: humanReviewRequired,
    confidence: Math.round(overallConfidence * 100) / 100,
    reason_codes: reasonCodes,
  };
}

// ============================================================================
// HTTP ROUTING AND HANDLER
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // GET /health
    if (pathname === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          status: 'ok',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }

    // POST /analyze-ticket
    if (pathname === '/analyze-ticket' && request.method === 'POST') {
      try {
        const body = await request.json() as AnalyzeTicketRequest;
        const response = await analyzeTicket(body, env);

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return new Response(
          JSON.stringify({
            error: 'Invalid request',
            message: errorMessage,
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          },
        );
      }
    }

    // Serve static frontend (default to index.html for root and any unknown paths)
    if (pathname === '/') {
      try {
        const html = await env.ASSETS?.get('/index.html');
        if (html) {
          return new Response(await html.text(), {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
            },
          });
        }
      } catch (e) {
        // ASSETS binding may not be available in all environments
      }
      // Fallback: return a simple error page
      return new Response('Not found - QueueStorm Investigator API. Use GET /health or POST /analyze-ticket', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Let Wrangler handle other static assets from public/
    // by returning 404, which triggers Wrangler's static file serving

    // OPTIONS for CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 404 fallback
    return new Response(
      JSON.stringify({
        error: 'Not found',
        message: `Endpoint ${pathname} not found`,
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  },
};

