/**
 * QueueStorm Investigator - Type Definitions
 * Complaint investigation copilot for digital finance platforms
 */

// Input Types
export type Language = 'en' | 'bn' | 'mixed';
export type Channel = 'in_app_chat' | 'call_center' | 'email' | 'merchant_portal' | 'field_agent';
export type UserType = 'customer' | 'merchant' | 'agent' | 'unknown';
export type TransactionType = 'transfer' | 'payment' | 'cash_in' | 'cash_out' | 'settlement' | 'refund';
export type TransactionStatus = 'completed' | 'failed' | 'pending' | 'reversed';

// Output Enums
export type EvidenceVerdict = 'consistent' | 'inconsistent' | 'insufficient_data';
export type CaseType = 
  | 'wrong_transfer' 
  | 'payment_failed' 
  | 'refund_request' 
  | 'duplicate_payment' 
  | 'merchant_settlement_delay' 
  | 'agent_cash_in_issue' 
  | 'phishing_or_social_engineering' 
  | 'other';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Department = 
  | 'customer_support' 
  | 'dispute_resolution' 
  | 'payments_ops' 
  | 'merchant_operations' 
  | 'agent_operations' 
  | 'fraud_risk';

// Transaction history item
export interface TransactionHistoryItem {
  transaction_id: string;
  timestamp: string; // ISO 8601 format
  type: TransactionType;
  amount: number;
  counterparty: string;
  status: TransactionStatus;
}

// Analyze Ticket Request
export interface AnalyzeTicketRequest {
  ticket_id: string;
  complaint: string;
  language?: Language;
  channel?: Channel;
  user_type?: UserType;
  campaign_context?: string;
  transaction_history?: TransactionHistoryItem[];
  metadata?: Record<string, unknown>;
}

// Analyze Ticket Response
export interface AnalyzeTicketResponse {
  ticket_id: string;
  relevant_transaction_id: string | null;
  evidence_verdict: EvidenceVerdict;
  case_type: CaseType;
  severity: Severity;
  department: Department;
  agent_summary: string;
  recommended_next_action: string;
  customer_reply: string;
  human_review_required: boolean;
  confidence?: number;
  reason_codes?: string[];
}

// Health check response
export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp?: string;
}

// Internal analysis context
export interface AnalysisContext {
  ticketId: string;
  complaint: string;
  language: Language;
  channel: Channel;
  userType: UserType;
  transactionHistory: TransactionHistoryItem[];
  metadata?: Record<string, unknown>;
}

// Match score for transactions
export interface TransactionMatchScore {
  transactionId: string;
  score: number;
  reasons: string[];
}

// Cloudflare Environment bindings
export interface Env {
  AI: Ai;
  ASSETS: { get: (path: string) => Promise<Response | null> };
  d1?: D1Database;
  r2?: R2Bucket;
  kv?: KVNamespace;
  VECTORIZE?: VectorizeIndex;
}
