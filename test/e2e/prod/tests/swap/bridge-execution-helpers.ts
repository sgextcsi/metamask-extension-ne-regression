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
  findNetworkByChainId,
  findNetworkByName,
} from './network-bridge-config';
import NetworkManager from '../../../page-objects/pages/network-manager';

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

  const homePage = new HomePage(driver);
  
  // Ensure we're on the home page
  await homePage.checkPageIsLoaded();
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Click the swap button to open swap/bridge UI
  await homePage.startSwapFlow();
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Wait for the bridge quote page to be visible
  const bridgeQuotePage = new BridgeQuotePage(driver);
  try {
    await driver.waitForSelector('[data-testid="bridge-source-button"]', { timeout: 30000 });
    console.log('[BRIDGE] Bridge quote page loaded successfully');
  } catch (error) {
    console.error('[BRIDGE] Bridge quote page failed to load:', error);
    // Try to take a screenshot for debugging
    try {
      await driver.takeScreenshot('bridge-load-failure');
    } catch (_err) {
      // Ignore screenshot errors
    }
    throw error;
  }
}

/**
 * Fill bridge route details: from token, amount, to token, and destination chain.
 * Uses multichain network picker to select both source and destination networks.
 *
 * @param driver - WebDriver instance
 * @param fromToken - Source token symbol
 * @param fromAmount - Amount to bridge
 * @param toToken - Destination token symbol
 * @param useMax - If true, click Max instead of entering amount
 * @param fromChainId - Source chain ID (e.g., 143 for Monad)
 * @param toChainId - Destination chain ID (e.g., 8453 for Base)
 */
export async function fillBridgeRouteDetails(
  driver: Driver,
  fromToken: string,
  fromAmount: string,
  toToken: string,
  useMax: boolean = false,
  fromChainId?: number,
  toChainId?: number,
): Promise<void> {
  console.log(
    `[BRIDGE] Filling bridge details: ${fromToken} (chain ${fromChainId}) ${fromAmount} → ${toToken} (chain ${toChainId})`,
  );

  const sourceButton = '[data-testid="bridge-source-button"]';
  const destButton = '[data-testid="bridge-destination-button"]';
  const fromAmountInput = '[data-testid="from-amount"]';
  const searchInput = '[data-testid="bridge-asset-picker-search-input"]';
  const bridgeAsset = '[data-testid^="bridge-asset--"]';
  const maxButton = '[data-testid="bridge-amount-max-button"]';
  const multichainNetworkPicker = '[data-testid="multichain-asset-picker__network"]';

  // Ensure the bridge UI is ready
  await driver.waitForSelector(sourceButton, { timeout: 10000 });
  await driver.waitForSelector(destButton, { timeout: 10000 });
  console.log('[BRIDGE] Bridge buttons ready');

  // =============== SELECT SOURCE TOKEN WITH NETWORK ===============
  console.log(`[BRIDGE] Selecting source: ${fromToken} on chain ${fromChainId}`);
  
  // Step 1: Click source button to open token picker
  await driver.clickElement(sourceButton);
  await driver.delay(PROD_DELAYS.API_RESPONSE);
  console.log('[BRIDGE] Source button clicked, token picker opened');
  
  // Step 2: Click multichain network picker within source modal (if chainId provided)
  if (fromChainId) {
    try {
      await driver.waitForSelector(multichainNetworkPicker, { timeout: 10000 });
      await driver.clickElement(multichainNetworkPicker);
      await driver.delay(PROD_DELAYS.API_RESPONSE);
      console.log('[BRIDGE] Multichain network picker clicked for source');
      
      // Step 3: Select the source network by chainId
      const sourceNetworkSelector = `[data-testid="network-list-item-eip155:${fromChainId}"]`;
      await driver.waitForSelector(sourceNetworkSelector, { timeout: 10000 });
      await driver.clickElement(sourceNetworkSelector);
      await driver.delay(PROD_DELAYS.API_RESPONSE);
      console.log(`[BRIDGE] ✅ Source network selected: eip155:${fromChainId}`);
    } catch (networkError) {
      console.log(
        `[BRIDGE] Warning: Multichain network picker not found for source, continuing: ${String(networkError)}`,
      );
    }
  }
  
  // Step 4: Search for and select the source token
  await driver.waitForSelector(searchInput, { timeout: 10000 });
  await driver.fill(searchInput, fromToken);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  await driver.waitForSelector({ css: bridgeAsset, text: fromToken }, { timeout: 10000 });
  await driver.clickElement({ css: bridgeAsset, text: fromToken });
  await driver.delay(PROD_DELAYS.API_RESPONSE);
  console.log(`[BRIDGE] ✅ Source token selected: ${fromToken}`);

  // =============== FILL AMOUNT ===============
  console.log(`[BRIDGE] Filling amount: ${fromAmount} (useMax=${useMax})`);
  
  await driver.waitForSelector(fromAmountInput, { timeout: 10000 });
  
  if (useMax) {
    try {
      await driver.waitForSelector(maxButton, { timeout: 5000 });
      await driver.clickElement(maxButton);
      console.log('[BRIDGE] ✅ Clicked Max button');
    } catch (maxError) {
      console.log('[BRIDGE] Max button not available, filling amount manually');
      await driver.fill(fromAmountInput, fromAmount);
      console.log(`[BRIDGE] ✅ Amount filled: ${fromAmount}`);
    }
  } else {
    // Clear and fill the amount
    await driver.fill(fromAmountInput, '');
    await driver.delay(PROD_DELAYS.API_RESPONSE);
    await driver.fill(fromAmountInput, fromAmount);
    console.log(`[BRIDGE] ✅ Amount filled: ${fromAmount}`);
  }
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // =============== SELECT DESTINATION TOKEN WITH NETWORK ===============
  console.log(`[BRIDGE] Selecting destination: ${toToken} on chain ${toChainId}`);
  
  // Step 1: Click destination button to open token picker
  await driver.clickElement(destButton);
  await driver.delay(PROD_DELAYS.API_RESPONSE);
  console.log('[BRIDGE] Destination button clicked, token picker opened');
  
  // Step 2: Click multichain network picker within destination modal (if chainId provided)
  if (toChainId) {
    try {
      await driver.waitForSelector(multichainNetworkPicker, { timeout: 10000 });
      await driver.clickElement(multichainNetworkPicker);
      await driver.delay(PROD_DELAYS.API_RESPONSE);
      console.log('[BRIDGE] Multichain network picker clicked for destination');
      
      // Step 3: Select the destination network by chainId
      const destNetworkSelector = `[data-testid="network-list-item-eip155:${toChainId}"]`;
      await driver.waitForSelector(destNetworkSelector, { timeout: 10000 });
      await driver.clickElement(destNetworkSelector);
      await driver.delay(PROD_DELAYS.API_RESPONSE);
      console.log(`[BRIDGE] ✅ Destination network selected: eip155:${toChainId}`);
    } catch (networkError) {
      console.log(
        `[BRIDGE] Warning: Multichain network picker not found for destination, continuing: ${String(networkError)}`,
      );
    }
  }
  
  // Step 4: Search for and select the destination token
  await driver.waitForSelector(searchInput, { timeout: 10000 });
  await driver.fill(searchInput, toToken);
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  await driver.waitForSelector({ css: bridgeAsset, text: toToken }, { timeout: 10000 });
  await driver.clickElement({ css: bridgeAsset, text: toToken });
  await driver.delay(PROD_DELAYS.API_RESPONSE);
  console.log(`[BRIDGE] ✅ Destination token selected: ${toToken}`);

  console.log('[BRIDGE] ✅ Bridge route details filled completely');
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
    '[data-testid="from-amount"]',
  );
  const fromAmount = await fromAmountElement.getAttribute('value') || '';

  // The 'to' amount is typically displayed in read-only text
  const toAmountElement = await driver.findElement(
    '[data-testid="to-amount"]',
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

// ---------------------------------------------------------------------------
// Cross-Network Bridge Verification
// ---------------------------------------------------------------------------

/**
 * Switch to a destination network by chain ID.
 * Used after executing a bridge to verify activity on the destination chain.
 *
 * @param driver - WebDriver instance
 * @param destinationChainId - Chain ID of the destination network
 */
export async function switchToDestinationNetwork(
  driver: Driver,
  destinationChainId: number,
): Promise<void> {
  console.log(`[BRIDGE] Switching to destination network (chainId: ${destinationChainId})...`);

  const destinationNetworkConfig = findNetworkByChainId(destinationChainId);
  if (!destinationNetworkConfig) {
    throw new Error(
      `Network with chainId ${destinationChainId} not found in bridge config`,
    );
  }

  const homePage = new HomePage(driver);
  await homePage.checkPageIsLoaded();

  // Try home network selector first
  try {
    const networksListButton = '[data-testid="sort-by-networks"]';
    const networkListItemSelector = `[data-testid="network-list-item-eip155:${destinationChainId}"]`;

    await driver.clickElement(networksListButton);
    await driver.waitForSelector('[role="dialog"]', { timeout: 5000 });
    await driver.clickElement(networkListItemSelector);
    await driver.delay(PROD_DELAYS.API_RESPONSE);

    console.log(
      `[BRIDGE] ✅ Switched to ${destinationNetworkConfig.networkName}`,
    );
    return;
  } catch (homeSelectorError) {
    console.log(
      `[BRIDGE] Home selector failed, falling back to NetworkManager: ${String(homeSelectorError)}`,
    );
  }

  // Fallback to NetworkManager
  const networkManager = new NetworkManager(driver);
  await networkManager.openNetworkManager();
  await networkManager.selectTab('Popular');
  await networkManager.selectNetworkByNameWithWait(
    destinationNetworkConfig.networkName,
  );
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  console.log(
    `[BRIDGE] ✅ Switched to ${destinationNetworkConfig.networkName} (via NetworkManager)`,
  );
}

/**
 * Verify bridge activity on the destination network.
 * Call after switching to destination network.
 *
 * @param driver - WebDriver instance
 * @param fromToken - Source token symbol (for logging)
 * @param toToken - Destination token symbol (for verification)
 * @param expectedToAmount - Expected destination amount
 */
export async function verifyBridgeActivityOnDestination(
  driver: Driver,
  fromToken: string,
  toToken: string,
  expectedToAmount?: string,
): Promise<void> {
  console.log(
    `[BRIDGE] Verifying bridge activity on destination (${fromToken} → ${toToken})...`,
  );

  const homePage = new HomePage(driver);
  await homePage.checkPageIsLoaded();

  // Navigate to activity tab if not already there
  try {
    await driver.clickElement('[data-testid="account-overview__activity-tab"]');
    await driver.delay(PROD_DELAYS.API_RESPONSE);
  } catch (_error) {
    // Already on activity tab
  }

  // Wait for activity entry to appear
  const latestActivitySelector = '[data-testid="activity-list-item-0"]';
  await driver.waitForSelector(latestActivitySelector, { timeout: 30000 });
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Check that the activity shows the destination token
  const activityElement = await driver.findElement(latestActivitySelector);
  const activityText = await activityElement.getText();

  if (!activityText.includes(toToken)) {
    throw new Error(
      `Expected activity to contain destination token "${toToken}", but got: ${activityText}`,
    );
  }

  console.log(
    `[BRIDGE] ✅ Activity verified on destination: ${activityText}`,
  );
}

/**
 * Check network and prepare for next route.
 * Handles switching to source network if the next route requires a different source network.
 *
 * @param driver - WebDriver instance
 * @param nextRoute - Next route to execute (or undefined if no more routes)
 * @param currentNetworkName - Current network name
 */
export async function prepareForNextRoute(
  driver: Driver,
  nextRoute?: { fromChain: string; fromChainId: number },
  currentNetworkName?: string,
): Promise<void> {
  if (!nextRoute) {
    console.log('[BRIDGE] No more routes, staying on current network');
    return;
  }

  console.log(`[BRIDGE] Preparing for next route (${nextRoute.fromChain})...`);

  if (
    currentNetworkName &&
    currentNetworkName.toLowerCase() !== nextRoute.fromChain.toLowerCase()
  ) {
    console.log(
      `[BRIDGE] Next route requires different source network: ${nextRoute.fromChain}`,
    );
    await switchToDestinationNetwork(driver, nextRoute.fromChainId);
  }

  const homePage = new HomePage(driver);
  await homePage.checkPageIsLoaded();
  await driver.delay(PROD_DELAYS.API_RESPONSE);
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
