/**
 * USDC Approval and Deposit Handler for Polymarket
 * 
 * Polymarket doesn't have a traditional "deposit" - USDC stays in your proxy wallet.
 * The exchange contracts just need APPROVAL to spend your USDC when orders fill.
 * 
 * This module handles:
 * 1. Checking current USDC allowance for exchange contracts
 * 2. Approving exchange contracts to spend USDC if needed
 */

import { ethers } from 'ethers';

// Polygon Mainnet contracts
const POLYGON_RPC = 'https://polygon-rpc.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// Minimal ERC20 ABI for approval and allowance
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

export interface ApprovalStatus {
  usdcBalance: number;
  ctfExchangeAllowance: number;
  negRiskExchangeAllowance: number;
  negRiskAdapterAllowance: number;
  needsApproval: boolean;
  details: string[];
}

/**
 * Check current USDC balance and allowances for all Polymarket contracts
 */
export async function checkApprovalStatus(proxyAddress: string): Promise<ApprovalStatus> {
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  const [balance, ctfAllowance, negRiskAllowance, adapterAllowance] = await Promise.all([
    usdc.balanceOf(proxyAddress),
    usdc.allowance(proxyAddress, CTF_EXCHANGE),
    usdc.allowance(proxyAddress, NEG_RISK_EXCHANGE),
    usdc.allowance(proxyAddress, NEG_RISK_ADAPTER),
  ]);

  const usdcBalance = Number(balance) / 1e6;
  const ctfExchangeAllowance = Number(ctfAllowance) / 1e6;
  const negRiskExchangeAllowance = Number(negRiskAllowance) / 1e6;
  const negRiskAdapterAllowance = Number(adapterAllowance) / 1e6;

  const details: string[] = [];
  let needsApproval = false;

  // Check if allowances are sufficient (need at least the balance amount)
  if (ctfExchangeAllowance < usdcBalance) {
    details.push(`CTF Exchange allowance ($${ctfExchangeAllowance.toFixed(2)}) < balance ($${usdcBalance.toFixed(2)})`);
    needsApproval = true;
  }
  if (negRiskExchangeAllowance < usdcBalance) {
    details.push(`NegRisk Exchange allowance ($${negRiskExchangeAllowance.toFixed(2)}) < balance ($${usdcBalance.toFixed(2)})`);
    needsApproval = true;
  }
  if (negRiskAdapterAllowance < usdcBalance) {
    details.push(`NegRisk Adapter allowance ($${negRiskAdapterAllowance.toFixed(2)}) < balance ($${usdcBalance.toFixed(2)})`);
    needsApproval = true;
  }

  return {
    usdcBalance,
    ctfExchangeAllowance,
    negRiskExchangeAllowance,
    negRiskAdapterAllowance,
    needsApproval,
    details,
  };
}

/**
 * Approve all Polymarket exchange contracts to spend USDC
 * Uses max uint256 for unlimited approval (standard practice)
 */
export async function approveAllExchanges(privateKey: string): Promise<{
  success: boolean;
  transactions: string[];
  error?: string;
}> {
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  const MAX_UINT256 = ethers.MaxUint256;
  const transactions: string[] = [];

  console.log('[Deposit] Approving USDC spending for Polymarket contracts...');
  console.log(`[Deposit] Wallet address: ${wallet.address}`);

  try {
    // Check current allowances
    const [ctfAllowance, negRiskAllowance, adapterAllowance] = await Promise.all([
      usdc.allowance(wallet.address, CTF_EXCHANGE),
      usdc.allowance(wallet.address, NEG_RISK_EXCHANGE),
      usdc.allowance(wallet.address, NEG_RISK_ADAPTER),
    ]);

    // Approve CTF Exchange if needed
    if (ctfAllowance < MAX_UINT256 / 2n) {
      console.log('[Deposit] Approving CTF Exchange...');
      const tx1 = await usdc.approve(CTF_EXCHANGE, MAX_UINT256);
      await tx1.wait();
      transactions.push(`CTF Exchange: ${tx1.hash}`);
      console.log(`[Deposit] ✅ CTF Exchange approved: ${tx1.hash}`);
    } else {
      console.log('[Deposit] CTF Exchange already approved');
    }

    // Approve NegRisk Exchange if needed
    if (negRiskAllowance < MAX_UINT256 / 2n) {
      console.log('[Deposit] Approving NegRisk Exchange...');
      const tx2 = await usdc.approve(NEG_RISK_EXCHANGE, MAX_UINT256);
      await tx2.wait();
      transactions.push(`NegRisk Exchange: ${tx2.hash}`);
      console.log(`[Deposit] ✅ NegRisk Exchange approved: ${tx2.hash}`);
    } else {
      console.log('[Deposit] NegRisk Exchange already approved');
    }

    // Approve NegRisk Adapter if needed
    if (adapterAllowance < MAX_UINT256 / 2n) {
      console.log('[Deposit] Approving NegRisk Adapter...');
      const tx3 = await usdc.approve(NEG_RISK_ADAPTER, MAX_UINT256);
      await tx3.wait();
      transactions.push(`NegRisk Adapter: ${tx3.hash}`);
      console.log(`[Deposit] ✅ NegRisk Adapter approved: ${tx3.hash}`);
    } else {
      console.log('[Deposit] NegRisk Adapter already approved');
    }

    console.log('[Deposit] All approvals complete!');
    return { success: true, transactions };

  } catch (error) {
    console.error('[Deposit] Approval failed:', error);
    return { 
      success: false, 
      transactions, 
      error: String(error) 
    };
  }
}

/**
 * Ensure USDC is approved for trading
 * Call this before placing orders
 */
export async function ensureApproved(
  proxyAddress: string, 
  privateKey: string
): Promise<boolean> {
  const status = await checkApprovalStatus(proxyAddress);
  
  console.log('[Deposit] Checking approval status...');
  console.log(`[Deposit]   USDC Balance: $${status.usdcBalance.toFixed(2)}`);
  console.log(`[Deposit]   CTF Exchange Allowance: $${status.ctfExchangeAllowance.toFixed(2)}`);
  console.log(`[Deposit]   NegRisk Exchange Allowance: $${status.negRiskExchangeAllowance.toFixed(2)}`);
  console.log(`[Deposit]   NegRisk Adapter Allowance: $${status.negRiskAdapterAllowance.toFixed(2)}`);

  if (!status.needsApproval) {
    console.log('[Deposit] ✅ All approvals in place');
    return true;
  }

  console.log('[Deposit] ⚠️  Approvals needed:');
  status.details.forEach(d => console.log(`[Deposit]   - ${d}`));

  const result = await approveAllExchanges(privateKey);
  return result.success;
}

/**
 * Debug function to print all relevant info
 */
export async function debugWalletStatus(proxyAddress: string): Promise<void> {
  console.log('\n[Deposit] ═══════════════════════════════════════════════════════');
  console.log('[Deposit] WALLET DEBUG INFO');
  console.log('[Deposit] ═══════════════════════════════════════════════════════');
  console.log(`[Deposit] Proxy Address: ${proxyAddress}`);
  
  const status = await checkApprovalStatus(proxyAddress);
  
  console.log(`[Deposit] USDC Balance: $${status.usdcBalance.toFixed(6)}`);
  console.log('[Deposit] Allowances:');
  console.log(`[Deposit]   CTF Exchange (${CTF_EXCHANGE}): $${status.ctfExchangeAllowance.toFixed(2)}`);
  console.log(`[Deposit]   NegRisk Exchange (${NEG_RISK_EXCHANGE}): $${status.negRiskExchangeAllowance.toFixed(2)}`);
  console.log(`[Deposit]   NegRisk Adapter (${NEG_RISK_ADAPTER}): $${status.negRiskAdapterAllowance.toFixed(2)}`);
  
  if (status.needsApproval) {
    console.log('[Deposit] ⚠️  NEEDS APPROVAL:');
    status.details.forEach(d => console.log(`[Deposit]   - ${d}`));
  } else {
    console.log('[Deposit] ✅ All approvals OK');
  }
  
  console.log('[Deposit] ═══════════════════════════════════════════════════════\n');
}

