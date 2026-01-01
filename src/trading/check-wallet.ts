/**
 * Quick wallet status check - run before trading to diagnose issues
 */

import 'dotenv/config';
import { debugWalletStatus, checkApprovalStatus, approveAllExchanges } from './deposit.js';

async function main() {
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;

  if (!proxyAddress) {
    console.error('POLYMARKET_PROXY_ADDRESS not set in .env');
    process.exit(1);
  }

  console.log('\n🔍 Polymarket Wallet Status Check\n');

  // Debug wallet status
  await debugWalletStatus(proxyAddress);

  // Check if we need to approve
  const status = await checkApprovalStatus(proxyAddress);
  
  if (status.needsApproval) {
    console.log('\n⚠️  Approvals needed. Run with --approve to fix:\n');
    console.log('   npm run check-wallet -- --approve\n');
    
    if (process.argv.includes('--approve')) {
      if (!privateKey) {
        console.error('POLYMARKET_PRIVATE_KEY not set - cannot approve');
        process.exit(1);
      }
      
      console.log('🔧 Setting up approvals...\n');
      const result = await approveAllExchanges(privateKey);
      
      if (result.success) {
        console.log('\n✅ All approvals set! You can now trade.\n');
      } else {
        console.error(`\n❌ Approval failed: ${result.error}\n`);
        process.exit(1);
      }
    }
  } else {
    console.log('✅ All approvals in place - ready to trade!\n');
  }
}

main().catch(console.error);

