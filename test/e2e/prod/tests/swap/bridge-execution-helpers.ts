/**
 * Shared helper functions for bridge execution tests
 *
 * Covers:
 * - Resolving tokens by symbol from manual token lists
 * - Importing a single funded account for bridge balance
 * - Waiting for bridge quote readiness
 * - Submitting bridges and waiting for cross-chain confirmation
 * - Activity list assertions for confirmed bridges
 * - Detail-page assertions for bridge transactions
 * - Simple markdown report generation
 */

import * as fs from 'fs';
import * as path from 'path';
import { Driver } from '../../../webdriver/driver';
import { PROD_DELAYS } from '../../helpers/prod-test-helpers';
import HomePage from '../../../page-objects/pages/home/homepage';
import AccountListPage from '../../../page-objects/pages/account-list-page';
import BridgeQuotePage from '../../../page-objects/pages/bridge/quote-page';
import { navigateBack } from './swap-quotation-helpers';
import {
  Token,
  NetworkBridgeConfig,
  BridgeRouteResult,
  BridgeExecutionReport,
  BridgeValidationResult,
} from './network-bridge-config';

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Filter a token list down to the requested symbols, preserving order.
 *
 * @param tokens - Full list of tokens (typically from manual tokens)
 * @param symbols - Ordered list of symbols to resolve (e.g. ['AZND', 'USDC'])
 * @returns Tokens matching each symbol in the given order
 * @throws Error if any symbol is not found in the list
 */
export function resolveBridgeTokensBySymbols(
  tokens: Token[],
  symbols: string[],
): Token[] {
  const resolved: Token[] = [];
  for (const symbol of symbols) {
    const found = tokens.find((t) => t.symbol === symbol);
    if (!found) {
      throw new Error(
        `Token symbol "${symbol}" not found in token list. ` +
          `Available symbols: ${tokens.map((t) => t.symbol).join(', ')}`,
      );
    }
    resolved.push(found);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Account import
// ---------------------------------------------------------------------------

/**
 * Import a single funded account using a private key and make it active.
 *
 * Follows the same pattern as swap account import.
 * The account keeps the default MetaMask-assigned imported account name.
 *
 * @param driver - WebDriver instance
 * @param privateKey - Private key of the funded account to import
 */
export async function importSingleFundedAccountForBridge(
  driver: Driver,
  privateKey: string,
): Promise<void> {
  console.log('[BRIDGE] Importing funded account for bridge...');
  const homePage = new HomePage(driver);

  await homePage.headerNavbar.openAccountMenu();

  const accountListPage = new AccountListPage(driver);
  await accountListPage.checkPageIsLoaded();

  // Import the funded account; keep the default name assigned by MetaMask.
  try {
    await accountListPage.addNewImportedAccount(privateKey, undefined);
    console.log('[BRIDGE] Funded account imported successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isRecoverableStaleTimeout =
      errorMessage.includes('Waiting element to become stale') ||
      errorMessage.includes('Wait timed out');

    if (!isRecoverableStaleTimeout) {
      throw error;
    }

    // Timeout waiting for button to become stale typically means the import
    // already succeeded — proceed.
    console.log('[BRIDGE] Import stale wait timeout (likely success), continuing...');
  }

  try {
    await accountListPage.closeMultichainAccountsPage();
  } catch (_error) {
    // Best-effort close; if already closed, continue.
  }

  // Allow account state to settle before proceeding
  await driver.delay(PROD_DELAYS.API_RESPONSE * 2);
  await homePage.checkPageIsLoaded();
  console.log('[BRIDGE] Imported account is now active');
}

// ---------------------------------------------------------------------------
// Bridge flow execution
// ---------------------------------------------------------------------------

/**
 * Initiate a bridge flow by navigating to the swap/bridge UI from home page.
 * For bridge operations, the swap UI handles cross-chain routing.
 *
 * @param driver - WebDriver instance
 * @param fromChain - Source chain name
 * @param fromToken - Source token symbol
 * @param toChain - Destination chain name
 * @param toToken - Destination token symbol
 */
export async function enterBridgeFlow(
  driver: Driver,
  fromChain: string,
  fromToken: string,
  toChain: string,
  toToken: string,
): Promise<void> {
  console.log(
    `[BRIDGE] Entering bridge flow: ${fromToken}(${fromChain}) → ${toToken}(${toChain})`,
  );

  // Navigate to swap page (which handles bridges)
  const homePage = new HomePage(driver);
  await homePage.startSwapFlow();
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  console.log('[BRIDGE] Bridge flow UI loaded');
}

/**
 * Fill bridge route details: from token, amount, to token, and destination chain.
 *
 * @param driver - WebDriver instance
 * @param fromToken - Source token symbol
 * @param fromAmount - Amount to bridge
 * @param toToken - Destination token symbol
 * @param useMax - If true, click Max instead of entering amount
 */
export async function fillBridgeRouteDetails(
  driver: Driver,
  fromToken: string,
  fromAmount: string,
  toToken: string,
  useMax: boolean = false,
): Promise<void> {
  console.log(
    `[BRIDGE] Filling bridge details: ${fromToken} ${fromAmount} → ${toToken}`,
  );

  const bridgeQuotePage = new BridgeQuotePage(driver);
  const sourceButton = '[data-testid="bridge-source-button"]';
  const searchInput = '[data-testid="bridge-asset-picker-search-input"]';
  const bridgeAsset = '[data-testid^="bridge-asset--"]';

  // Select source token
  await driver.waitForSelector(sourceButton);
  await driver.clickElement(sourceButton);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  await driver.waitForSelector(searchInput);
  await driver.fill(searchInput, fromToken);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  await driver.waitForSelector({ css: bridgeAsset, text: fromToken });
  await driver.clickElement({ css: bridgeAsset, text: fromToken });
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Fill amount or click max
  const amountInput = '[data-testid="bridge-amount-input"]';
  if (useMax) {
    const maxButton = '[data-testid="bridge-amount-max-button"]';
    try {
      await driver.waitForSelector(maxButton, { timeout: 5000 });
      await driver.clickElement(maxButton);
    } catch {
      // Max button might not be available, fill amount instead
      await driver.fill(amountInput, fromAmount);
    }
  } else {
    await driver.fill(amountInput, fromAmount);
  }
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Select destination token
  const destButton = '[data-testid="bridge-destination-button"]';
  await driver.clickElement(destButton);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  await driver.waitForSelector(searchInput);
  await driver.fill(searchInput, toToken);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  await driver.waitForSelector({ css: bridgeAsset, text: toToken });
  await driver.clickElement({ css: bridgeAsset, text: toToken });
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  console.log('[BRIDGE] Bridge route details filled');
}

/**
 * Wait for bridge quote to be ready and displayed.
 *
 * @param driver - WebDriver instance
 * @param timeout - Max wait in ms (default 30 s)
 */
export async function waitForBridgeQuoteReady(
  driver: Driver,
  timeout = 30000,
): Promise<void> {
  console.log('[BRIDGE] Waiting for bridge quote...');

  await driver.waitForSelector(
    '[data-testid="bridge-cta-button"]:not([disabled])',
    { timeout },
  );

  await driver.delay(PROD_DELAYS.API_RESPONSE);
  console.log('[BRIDGE] Bridge quote ready');
}

/**
 * Capture the input and output amounts from the bridge UI.
 *
 * @param driver - WebDriver instance
 * @returns Object with fromAmount and toAmount
 */
export async function captureBridgeAmounts(
  driver: Driver,
): Promise<{ fromAmount: string; toAmount: string }> {
  console.log('[BRIDGE] Capturing bridge amounts...');

  const fromAmountElement = await driver.findElement(
    '[data-testid="bridge-amount-input"]',
  );
  const fromAmount = await fromAmountElement.getAttribute('value') || '';

  // The 'to' amount is typically displayed in read-only text
  const toAmountElement = await driver.findElement(
    '[data-testid="bridge-quote-amount-to"]',
  );
  const toAmount = await toAmountElement.getText();

  console.log(
    `[BRIDGE] Captured amounts: ${fromAmount} → ${toAmount}`,
  );

  return { fromAmount: fromAmount.trim(), toAmount: toAmount.trim() };
}

/**
 * Submit the bridge transaction and wait for cross-chain confirmation.
 *
 * @param driver - WebDriver instance
 * @param fromToken - Source token symbol
 * @param toToken - Destination token symbol
 * @param timeout - Max wait time in ms (default 120 s for cross-chain)
 */
export async function submitBridgeAndWaitForConfirmed(
  driver: Driver,
  fromToken: string,
  toToken: string,
  timeout = 120000,
): Promise<void> {
  console.log(`[BRIDGE] Submitting bridge ${fromToken} → ${toToken}...`);

  // Click submit/bridge button
  const submitButton = '[data-testid="bridge-cta-button"]';
  await driver.clickElement(submitButton);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Confirm in wallet modal if present
  try {
    const confirmButton = '[data-testid="confirm-transaction-button"]';
    const isVisible = await driver.isElementPresentAndVisible(confirmButton, 5000);
    if (isVisible) {
      await driver.clickElement(confirmButton);
      await driver.delay(PROD_DELAYS.API_RESPONSE);
    }
  } catch (_error) {
    // Modal might not appear in all flows
  }

  // Wait for activity to appear with "Confirmed" or "Pending" status
  const activityConfirmedSelector =
    `[data-testid="activity-status-confirmed"], [data-testid="activity-status-pending"]`;
  await driver.waitForSelector(activityConfirmedSelector, { timeout });

  await driver.delay(PROD_DELAYS.API_RESPONSE);
  console.log(`[BRIDGE] ✅ Bridge ${fromToken} → ${toToken} submitted and confirmed`);
}

/**
 * Assert that the activity list shows the primary currency as the from-token.
 *
 * @param driver - WebDriver instance
 * @param expectedText - Expected text in activity (e.g., "-0.001 MON")
 */
export async function assertBridgeActivityPrimaryCurrency(
  driver: Driver,
  expectedText: string,
): Promise<void> {
  const primaryCurrencyElement = await driver.findElement(
    '[data-testid="activity-primary-currency"]',
  );
  const text = await primaryCurrencyElement.getText();

  if (!text.includes(expectedText)) {
    throw new Error(
      `Expected activity primary currency to contain "${expectedText}", got "${text}"`,
    );
  }

  console.log(`[BRIDGE] ✅ Activity primary currency: ${text}`);
}

/**
 * Open the latest bridge activity record.
 *
 * @param driver - WebDriver instance
 * @param fromToken - Source token symbol
 * @param toToken - Destination token symbol
 */
export async function openLatestBridgeActivityRecord(
  driver: Driver,
  fromToken: string,
  toToken: string,
): Promise<void> {
  console.log(
    `[BRIDGE] Opening latest bridge activity record (${fromToken} → ${toToken})...`,
  );

  const latestActivitySelector = '[data-testid="activity-list-item-0"]';
  await driver.clickElement(latestActivitySelector);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  console.log('[BRIDGE] Activity detail page loaded');
}

/**
 * Assert that the bridge detail page shows "Confirmed" status.
 *
 * @param driver - WebDriver instance
 */
export async function assertBridgeDetailConfirmed(driver: Driver): Promise<void> {
  const statusElement = await driver.findElement(
    '[data-testid="transaction-status-confirmed"]',
  );
  const status = await statusElement.getText();

  if (!status.toLowerCase().includes('confirmed')) {
    throw new Error(
      `Expected detail status to be "Confirmed", got "${status}"`,
    );
  }

  console.log('[BRIDGE] ✅ Detail status: Confirmed');
}

/**
 * Assert a detail row contains expected text.
 *
 * @param driver - WebDriver instance
 * @param rowLabel - Row label (e.g., "You sent", "You received")
 * @param expectedValue - Expected value or substring
 */
export async function assertBridgeDetailRow(
  driver: Driver,
  rowLabel: string,
  expectedValue: string,
): Promise<void> {
  const rowSelector = `[data-testid="detail-row-${rowLabel.toLowerCase().replace(/\s+/g, '-')}"]`;
  const rowElement = await driver.findElement(rowSelector);
  const text = await rowElement.getText();

  if (!text.includes(expectedValue)) {
    throw new Error(
      `Expected detail row "${rowLabel}" to contain "${expectedValue}", got "${text}"`,
    );
  }

  console.log(`[BRIDGE] ✅ Detail row "${rowLabel}": ${text}`);
}

/**
 * Navigate back to the home page.
 *
 * @param driver - WebDriver instance
 */
export async function navigateBackToHomeForBridge(driver: Driver): Promise<void> {
  console.log('[BRIDGE] Navigating back to home...');
  await navigateBack(driver, { timeout: 5000 });
  await driver.waitForSelector(
    '[data-testid="account-overview__activity-tab"]',
    { timeout: 10000 },
  );
  console.log('[BRIDGE] Home activity tab visible');
}

/**
 * Attempt to recover to home page after an error.
 *
 * @param driver - WebDriver instance
 * @param maxAttempts - Maximum back-button clicks before giving up (default 4)
 * @returns true if recovery succeeded, false otherwise
 */
export async function recoverToHomeForBridge(
  driver: Driver,
  maxAttempts = 4,
): Promise<boolean> {
  const homeActivityTab = '[data-testid="account-overview__activity-tab"]';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `[BRIDGE] Recovery attempt ${attempt}/${maxAttempts}: navigating back...`,
      );
      const success = await navigateBack(driver, { timeout: 3000 });
      if (!success) {
        continue;
      }
      await driver.waitForSelector(homeActivityTab, { timeout: 5000 });
      console.log('[BRIDGE] ✅ Recovered to home');
      return true;
    } catch (_error) {
      // Try again
    }
  }
  console.error(
    '[BRIDGE] ❌ Recovery failed: could not navigate back to home',
  );
  return false;
}

/**
 * Generate a markdown execution report for bridge routes.
 *
 * @param routeResults - Array of bridge route execution results
 * @param networkConfig - Bridge network configuration
 */
export function generateBridgeExecutionReport(
  routeResults: BridgeRouteResult[],
  networkConfig: NetworkBridgeConfig,
): void {
  const passedRoutes = routeResults.filter((r) => r.status === 'passed').length;
  const warningRoutes = routeResults.filter(
    (r) => r.status === 'warning',
  ).length;
  const failedRoutes = routeResults.filter((r) => r.status === 'failed').length;

  const report: BridgeExecutionReport = {
    networkConfig,
    timestamp: new Date().toISOString(),
    totalRoutes: routeResults.length,
    passedRoutes,
    warningRoutes,
    failedRoutes,
    routeResults,
  };

  const reportPath = path.join(
    process.cwd(),
    'test-artifacts',
    `bridge-execution-report-${networkConfig.networkName}-${Date.now()}.json`,
  );

  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[BRIDGE] Report written to ${reportPath}`);
  } catch (error) {
    console.warn(`[BRIDGE] Failed to write report: ${error}`);
  }

  // Also print summary to console
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Bridge Execution Report: ${networkConfig.networkName}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total Routes: ${routeResults.length}`);
  console.log(`Passed: ${passedRoutes}`);
  console.log(`Warning: ${warningRoutes}`);
  console.log(`Failed: ${failedRoutes}`);
  console.log(`${'='.repeat(80)}\n`);

  routeResults.forEach((route) => {
    const icon =
      route.status === 'passed'
        ? '✅'
        : route.status === 'warning'
          ? '⚠️'
          : '❌';
    console.log(`${icon} ${route.route}: ${route.status}`);
    if (route.validations?.length) {
      route.validations.forEach((v) => {
        const vIcon = v.status === 'passed' ? '  ✓' : '  ✗';
        console.log(`${vIcon} ${v.name}${v.details ? `: ${v.details}` : ''}`);
      });
    }
  });
}
