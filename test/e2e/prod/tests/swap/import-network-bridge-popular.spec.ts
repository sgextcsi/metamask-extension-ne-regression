/**
 * Production E2E Test: Popular-Network Bridge Execution
 *
 * Executes two cross-network bridge operations via the swap UI:
 * 1) MON (Monad) -> USDC (Base), amount 20
 * 2) USDC (Base) -> MON (Monad), amount 0.5
 *
 * Validation goals:
 * - Activity shows Swap action and sent amount
 * - Activity status can be pending or confirmed (both accepted)
 * - Bridge details page is opened and validated (pending or confirmed/complete accepted)
 *
 * Notes:
 * - Route 2 must hard-fail if Base USDC is not available at runtime.
 * - This spec does not modify existing swap execution specs.
 */

import { Suite } from 'mocha';
import FixtureBuilder from '../../../fixtures/fixture-builder';
import { withProductionFixtures } from '../../helpers/prod-with-fixtures';
import { PROD_DELAYS } from '../../helpers/prod-test-helpers';
import { loginWithoutBalanceValidation } from '../../../page-objects/flows/login.flow';
import HomePage from '../../../page-objects/pages/home/homepage';
import NetworkManager from '../../../page-objects/pages/network-manager';
import AssetListPage from '../../../page-objects/pages/home/asset-list';
import { Driver } from '../../../webdriver/driver';
import { getRequiredE2EEnv } from '../../../helpers/e2e-env';
import { SwapRouteResult, SwapValidationResult } from './network-swap-config';
import { performSwapFlow } from './swap-quotation-helpers';
import {
  importSingleFundedAccount,
  waitForSwapQuoteReady,
  assertCtaFeeText,
  captureSwapAmounts,
  assertActivityPrimaryCurrency,
  assertDetailRow,
  navigateBackToHome,
  recoverToHome,
} from './swap-execution-helpers';

type BridgeRouteConfig = {
  label: string;
  sourceNetwork: string;
  destinationNetwork: string;
  fromSymbol: string;
  toSymbol: string;
  fromAmount: string;
  destinationAddress: string;
  homeNetworkFilter: string;
  acceptedActivityLabels: string[];
  swapActivityLabel: string;
  acceptedDetailStatuses?: string[];
  hardFailOnInsufficientFunds?: boolean;
};

const BASE_CHAIN_ID_HEX = '0x2105';
const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BRIDGE_TO_SWAP_TRANSITION_TIMEOUT = 240000;
const INITIAL_ACTIVITY_LABEL_TIMEOUT = 120000;
const DEFAULT_ACCEPTED_DETAIL_STATUSES = ['pending', 'confirmed', 'complete'];

const BRIDGE_ROUTES: BridgeRouteConfig[] = [
  {
    label: 'MON -> USDC (Monad -> Base)',
    sourceNetwork: 'Monad',
    destinationNetwork: 'Base',
    fromSymbol: 'MON',
    toSymbol: 'USDC',
    fromAmount: '20',
    destinationAddress: BASE_USDC_ADDRESS,
    homeNetworkFilter: 'Monad',
    acceptedActivityLabels: ['Bridged to Base', 'Swap MON to USDC'],
    swapActivityLabel: 'Swap MON to USDC',
  },
  {
    label: 'USDC -> MON (Base -> Monad)',
    sourceNetwork: 'Base',
    destinationNetwork: 'Monad',
    fromSymbol: 'USDC',
    toSymbol: 'MON',
    fromAmount: '0.5',
    destinationAddress: 'MON',
    homeNetworkFilter: 'Base',
    acceptedActivityLabels: ['Bridged to Monad', 'Swap USDC to MON'],
    swapActivityLabel: 'Swap USDC to MON',
    hardFailOnInsufficientFunds: true,
  },
];

/**
 * Networks pre-configured in the fixture (via withNetworkControllerOnMonad etc.)
 * can be switched to directly without going through the Popular tab.
 */
const FIXTURE_CONFIGURED_NETWORKS = new Set(['Monad']);

async function switchToNetwork(
  driver: Driver,
  networkName: string,
): Promise<void> {
  const networkManager = new NetworkManager(driver);
  const homePage = new HomePage(driver);
  const networkManagerCloseButton = '[data-testid="modal-header-close-button"]';

  await networkManager.openNetworkManager();

  if (FIXTURE_CONFIGURED_NETWORKS.has(networkName)) {
    // Network is pre-configured in the fixture — switch directly without Popular tab.
    try {
      await networkManager.checkNetworkIsSelected(networkName);
      await networkManager.closeNetworkManager();
    } catch (_error) {
      await networkManager.selectNetworkByName(networkName);
    }
  } else {
    // Network may need to be added — try Popular tab first, then Add tab.
    try {
      await networkManager.selectTab('Popular');
      try {
        await networkManager.checkNetworkIsSelected(networkName);
        await networkManager.closeNetworkManager();
      } catch (_error) {
        await networkManager.selectNetworkByName(networkName);
      }
    } catch (_error) {
      await networkManager.selectTab('Add');
      try {
        await networkManager.checkNetworkIsSelected(networkName);
        await networkManager.closeNetworkManager();
      } catch (_innerError) {
        await networkManager.selectNetworkByName(networkName);
      }
    }
  }

  try {
    await driver.waitForSelector(networkManagerCloseButton, { timeout: 2000 });
    await driver.clickElement(networkManagerCloseButton);
  } catch (_error) {
    // Network selection usually closes the manager automatically.
  }

  await homePage.checkPageIsLoaded();
  await driver.delay(PROD_DELAYS.API_RESPONSE);
}

async function verifyUsdcTokenInAssetList(
  assetListPage: AssetListPage,
  timeoutMs: number = 15000,
): Promise<void> {
  /**
   * USDC can display as either symbol 'USDC' or full name 'USD Coin'
   * depending on tokenlist source. Try both variations.
   */
  const usdcVariations = ['USDC', 'USD Coin'];

  for (const tokenName of usdcVariations) {
    try {
      console.log(
        `[TEST] Attempting to find token as: "${tokenName}" (timeout: ${timeoutMs}ms)...`,
      );
      await assetListPage.checkTokenExistsInList(tokenName, undefined, {
        timeout: timeoutMs,
      });
      console.log(`[TEST] ✅ Token found as: "${tokenName}"`);
      return;
    } catch (error) {
      console.log(`[TEST] ⚠️  Token not found as: "${tokenName}". Trying next...`);
      // Try next variation
    }
  }

  // If we got here, no variations were found
  throw new Error(
    `USDC token not found under any variation: ${usdcVariations.join(', ')}. Timeout was ${timeoutMs}ms per attempt.`,
  );
}

async function ensureBaseUsdcImported(driver: Driver): Promise<void> {
  console.log('[TEST] ── Ensuring Base USDC is imported ──');

  // Step 1: Switch to Base network
  console.log('[TEST] Switching to Base network...');
  await switchToNetwork(driver, 'Base');
  console.log('[TEST] Extended delay after network switch...');
  await driver.delay(3000); // Extended delay to allow network context to settle

  const homePage = new HomePage(driver);
  const assetListPage = new AssetListPage(driver);

  // Step 2: Navigate to tokens tab
  console.log('[TEST] Navigating to tokens tab...');
  await homePage.goToTokensTab();
  console.log('[TEST] Waiting for token list to load...');
  await driver.delay(PROD_DELAYS.API_RESPONSE * 2); // Extended delay for tab to fully load

  // Step 3: Pre-check — Try to find USDC in current list (short timeout)
  console.log(
    '[TEST] Pre-check: Looking for USDC in asset list (short timeout)...',
  );
  try {
    await verifyUsdcTokenInAssetList(assetListPage, 3000);
    console.log('[TEST] ✅ USDC found in asset list. Import not needed.');
    return;
  } catch (_preCheckError) {
    console.log(
      '[TEST] ⚠️  USDC not found in asset list. Will proceed with import.',
    );
  }

  // Step 4: Import USDC with metadata (symbol + decimals to skip RPC detection)
  console.log(
    '[TEST] Importing Base USDC token with metadata to skip slow RPC detection...',
  );
  let importSucceeded = false;
  let importErrorMessage = '';

  try {
    // Pass symbol='USDC' and decimals='6' to skip RPC detection timeout
    console.log('[TEST] Calling importCustomTokenByChain for USDC...');
    await assetListPage.importCustomTokenByChain(
      BASE_CHAIN_ID_HEX,
      BASE_USDC_ADDRESS,
      'USDC', // symbol
      '6', // decimals
    );
    console.log('[TEST] ✅ USDC import completed successfully.');
    importSucceeded = true;
  } catch (importError: any) {
    importErrorMessage = String(importError?.message || importError || '');
    console.log('[TEST] Import error encountered:', importErrorMessage);

    // Check if error indicates token already exists (acceptable outcome)
    if (
      importErrorMessage.includes('already been added') ||
      importErrorMessage.includes('already exists') ||
      importErrorMessage.includes('Token has already been added') ||
      importErrorMessage.includes('Token with the same address already exists')
    ) {
      console.log(
        '[TEST] ℹ️  USDC token already exists in wallet (import skipped). Continuing...',
      );
      importSucceeded = true;
    } else {
      console.error(
        '[TEST] ❌ Unexpected error during import. Will proceed to verification anyway.',
      );
      // Don't throw yet — proceed to verification to see if token is actually present
    }
  }

  // Step 5: Wait for import/UI to settle
  console.log('[TEST] Waiting for import to complete and UI to refresh...');
  await driver.delay(PROD_DELAYS.TOKEN_BALANCE_UPDATE * 2);

  // Step 6: Ensure we're viewing tokens on Base network by refreshing the view
  console.log(
    '[TEST] Refreshing token list view to ensure fresh state...',
  );
  await homePage.goToTokensTab();
  await driver.delay(PROD_DELAYS.API_RESPONSE);

  // Step 7: Try to expand low-value assets in case USDC is hidden there
  console.log('[TEST] Attempting to expand low-value assets...');
  try {
    const expandButton = 'button[data-testid="account-overview__expand-button"]';
    const isPresent = await driver.isElementPresentAndVisible(expandButton, 1000);
    if (isPresent) {
      console.log('[TEST] Expanding low-value assets section...');
      await driver.clickElement(expandButton);
      await driver.delay(1000);
    }
  } catch (_error) {
    console.log('[TEST] ℹ️  Low-value assets expansion not available (OK)');
  }

  // Step 8: Post-import verification with extended timeout and retry logic
  console.log(
    '[TEST] Verifying USDC is visible in asset list (extended timeout with retries)...',
  );
  let verificationAttempt = 0;
  const maxVerificationAttempts = 5; // Increased from 3 to 5
  let lastVerificationError: any = null;

  while (verificationAttempt < maxVerificationAttempts) {
    try {
      verificationAttempt++;
      console.log(
        `[TEST] Verification attempt ${verificationAttempt}/${maxVerificationAttempts}...`,
      );

      // Use verifyUsdcTokenInAssetList which checks both symbol and name
      await verifyUsdcTokenInAssetList(assetListPage, 15000);
      console.log('[TEST] ✅ USDC successfully verified in asset list.');
      return;
    } catch (verificationError: any) {
      lastVerificationError = verificationError;
      console.warn(
        `[TEST] ⚠️  Verification attempt ${verificationAttempt} failed.`,
      );

      if (verificationAttempt < maxVerificationAttempts) {
        console.log(
          `[TEST] Retrying... (${maxVerificationAttempts - verificationAttempt} attempts remaining)`,
        );
        // Longer wait between retries
        await driver.delay(3000);

        // Refresh the asset list view
        console.log('[TEST] Refreshing asset list...');
        await homePage.goToTokensTab();
        await driver.delay(PROD_DELAYS.API_RESPONSE);
      }
    }
  }

  // If we got here, all verification attempts failed
  const finalErrorMsg = `Failed to verify Base USDC after ${maxVerificationAttempts} verification attempts. Import result: ${
    importSucceeded ? 'SUCCESS' : 'FAILED'
  }. Last verification error: ${
    lastVerificationError?.message || lastVerificationError
  }${importErrorMessage ? `. Import error: ${importErrorMessage}` : ''}`;

  console.error('[TEST] ❌', finalErrorMsg);
  throw new Error(finalErrorMsg);
}

async function assertNoInsufficientFunds(
  driver: Driver,
  routeLabel: string,
): Promise<void> {
  const insufficientSelector = {
    css: '[data-testid="bridge-cta-button"]',
    text: 'Insufficient funds',
  };

  try {
    await driver.waitForSelector(insufficientSelector, { timeout: 4000 });
    throw new Error(
      `Hard failure for ${routeLabel}: Insufficient funds shown for route execution`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Hard failure for')) {
      throw error;
    }
    // Selector not found within timeout means no insufficient-funds block.
  }
}

async function resetToTokensHomeForRoute(
  driver: Driver,
  route: BridgeRouteConfig,
): Promise<void> {
  const homePage = new HomePage(driver);
  const assetListPage = new AssetListPage(driver);

  await recoverToHome(driver);
  await homePage.checkPageIsLoaded();
  await homePage.goToTokensTab();
  await driver.delay(PROD_DELAYS.API_RESPONSE);
  await assetListPage.selectNetworkFilter(route.homeNetworkFilter);
  await assetListPage.checkNetworkFilterText(route.homeNetworkFilter);
  await driver.delay(PROD_DELAYS.API_RESPONSE);
}

async function openActivityTabFromHome(driver: Driver): Promise<void> {
  const homePage = new HomePage(driver);

  await homePage.goToActivityList();
  await driver.waitForSelector(
    '[data-testid="account-overview__activity-tab"]',
  );
  await driver.delay(PROD_DELAYS.API_RESPONSE);
}

async function waitForAnyActivityLabel(
  driver: Driver,
  acceptedLabels: string[],
  timeout: number,
): Promise<string> {
  let matchedLabel = '';

  await driver.waitUntil(
    async () => {
      for (const label of acceptedLabels) {
        const matches = await driver.findElements({ tag: 'p', text: label });
        if (matches.length > 0) {
          matchedLabel = label;
          return true;
        }
      }

      return false;
    },
    { timeout, interval: 1000 },
  );

  if (!matchedLabel) {
    throw new Error(
      `No accepted activity label appeared within ${timeout}ms. Expected one of: ${acceptedLabels.join(', ')}`,
    );
  }

  return matchedLabel;
}

async function assertActivityHasAcceptedStatus(
  driver: Driver,
): Promise<string> {
  const acceptedStatuses = ['pending', 'confirmed'];

  for (const status of acceptedStatuses) {
    try {
      await driver.waitForSelector(
        {
          css: '[data-testid="transaction-status-label"]',
          text: status,
        },
        { timeout: 3000 },
      );
      return status;
    } catch (_error) {
      // Try next accepted status.
    }
  }

  // Fallback for alternate bridge pending style.
  const pendingBridgeStatus = '.bridge-transaction-details__segment--pending';
  try {
    await driver.waitForSelector(pendingBridgeStatus, { timeout: 3000 });
    return 'pending';
  } catch (_error) {
    throw new Error(
      'Activity status did not show an accepted value (pending or confirmed)',
    );
  }
}

async function submitBridgeAndWaitForActivity(
  driver: Driver,
  route: BridgeRouteConfig,
): Promise<{ transitionToSwap: boolean; activityLabel: string }> {
  console.log(
    `[EXEC] Submitting bridge and waiting for activity. Accepted labels: ${route.acceptedActivityLabels.join(', ')}`,
  );
  await driver.clickElement('[data-testid="bridge-cta-button"]');

  // Allow the transaction to be submitted before returning home.
  await driver.delay(PROD_DELAYS.API_RESPONSE * 2);
  await resetToTokensHomeForRoute(driver, route);
  await openActivityTabFromHome(driver);

  const initialLabelFound = await waitForAnyActivityLabel(
    driver,
    route.acceptedActivityLabels,
    INITIAL_ACTIVITY_LABEL_TIMEOUT,
  );
  console.log(`[EXEC] Activity appeared as: "${initialLabelFound}"`);

  if (initialLabelFound === route.swapActivityLabel) {
    return { transitionToSwap: true, activityLabel: route.swapActivityLabel };
  }

  console.log(
    `[EXEC] Waiting for Bridged->Swap transition: "${route.swapActivityLabel}" (timeout: ${BRIDGE_TO_SWAP_TRANSITION_TIMEOUT}ms)`,
  );
  try {
    await waitForAnyActivityLabel(
      driver,
      [route.swapActivityLabel],
      BRIDGE_TO_SWAP_TRANSITION_TIMEOUT,
    );
    console.log('[EXEC] ✅ Activity transitioned from Bridged to Swap');
    return { transitionToSwap: true, activityLabel: route.swapActivityLabel };
  } catch (_error) {
    console.warn(
      `[EXEC] ⚠️  ALERT: Activity did not transition from Bridged to Swap within ${BRIDGE_TO_SWAP_TRANSITION_TIMEOUT}ms. Proceeding to Bridge details validation.`,
    );
    return { transitionToSwap: false, activityLabel: initialLabelFound };
  }
}

async function openLatestBridgeActivityRecord(
  driver: Driver,
  route: BridgeRouteConfig,
): Promise<void> {
  const normalize = (value: string) =>
    value.replace(/\s+/gu, ' ').trim().toUpperCase();
  const acceptedActivityLabels = route.acceptedActivityLabels.map(normalize);

  await driver.waitForSelector('[data-testid="activity-list-item-action"]');
  const activityRows = await driver.findElements(
    '[data-testid="activity-list-item-action"]',
  );

  let clicked = false;
  for (const row of activityRows) {
    const text = normalize(await row.getText());
    const isAcceptedMatch = acceptedActivityLabels.some((label) =>
      text.includes(label),
    );

    if (isAcceptedMatch) {
      console.log(
        `[EXEC] Opening matching activity row for bridge route: "${text}"`,
      );
      await row.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    for (const activityLabel of route.acceptedActivityLabels) {
      try {
        await driver.clickElement({ tag: 'p', text: activityLabel });
        clicked = true;
        break;
      } catch (_error) {
        // Try the next accepted activity label.
      }
    }
  }

  if (!clicked) {
    throw new Error(
      `Could not open any matching activity record for route ${route.label}`,
    );
  }

  await driver.waitForUrlContaining({ url: '/cross-chain/tx-details' });
}

async function navigateBackToActivityTab(driver: Driver): Promise<void> {
  await navigateBackToHome(driver);
  await driver.waitForSelector('[data-testid="activity-list-item-action"]');
}

async function getDetailRowText(
  driver: Driver,
  rowLabel: string,
): Promise<string> {
  const xpath = `//*[@data-testid="transaction-detail-row"]/p[text()='${rowLabel}']/..`;
  const rowEl = await driver.findElement({ xpath });
  return await rowEl.getText();
}

async function assertBridgeDetailsPage(
  driver: Driver,
  route: BridgeRouteConfig,
  fromAmount: string,
): Promise<{ status: string; details: string[] }> {
  await driver.waitForUrlContaining({ url: '/cross-chain/tx-details' });
  await driver.waitForSelector({ text: 'Bridge details' });

  const detailMessages: string[] = [];

  const statusElement = await driver.findElement(
    '[data-testid="bridge-transaction-details-tx-status"]',
  );
  const statusText = (await statusElement.getText()).trim().toLowerCase();
  const acceptedStatuses =
    route.acceptedDetailStatuses ?? DEFAULT_ACCEPTED_DETAIL_STATUSES;
  if (!acceptedStatuses.includes(statusText)) {
    throw new Error(
      `Bridge details status is not accepted. Got "${statusText}", expected ${acceptedStatuses.join('/')}`,
    );
  }
  detailMessages.push(`Status: ${statusText}`);

  const bridgingRowText = await getDetailRowText(driver, 'Bridging');
  if (
    !bridgingRowText.includes(route.sourceNetwork) ||
    !bridgingRowText.includes(route.destinationNetwork)
  ) {
    throw new Error(
      `Bridging row mismatch. Got "${bridgingRowText}", expected to include "${route.sourceNetwork}" and "${route.destinationNetwork}"`,
    );
  }
  detailMessages.push(`Bridging row: ${bridgingRowText}`);

  const timeStampRowText = await getDetailRowText(driver, 'Time stamp');
  const timeStampValue = timeStampRowText
    .replace(/\bTime stamp\b/gu, '')
    .trim();
  if (!timeStampValue) {
    throw new Error('Time stamp value is empty on Bridge details page');
  }
  detailMessages.push(`Time stamp: ${timeStampValue}`);

  await assertDetailRow(
    driver,
    'You sent',
    `${fromAmount} ${route.fromSymbol}`,
  );
  detailMessages.push(`You sent includes: ${fromAmount} ${route.fromSymbol}`);

  const receivedRowText = await getDetailRowText(driver, 'You received');
  if (!receivedRowText.includes(route.toSymbol)) {
    throw new Error(
      `You received row mismatch. Expected token ${route.toSymbol}, got "${receivedRowText}"`,
    );
  }
  detailMessages.push(`You received row: ${receivedRowText}`);

  const gasFeeRowText = await getDetailRowText(driver, 'Total gas fee');
  const gasFeeValue = gasFeeRowText.replace(/\bTotal gas fee\b/gu, '').trim();
  if (!gasFeeValue) {
    throw new Error('Total gas fee value is empty on Bridge details page');
  }
  detailMessages.push(`Total gas fee: ${gasFeeValue}`);

  return {
    status: statusText,
    details: detailMessages,
  };
}

describe('Production E2E: Popular Network Bridge Execution', function (this: Suite) {
  this.timeout(900000);

  it('executes MON->USDC and USDC->MON cross-network bridge operations', async function () {
    const routeResults: SwapRouteResult[] = [];

    await withProductionFixtures(
      {
        fixtures: new FixtureBuilder().withNetworkControllerOnMonad().build(),
        title:
          this.test?.fullTitle() ||
          'Popular network bridge execution (MON<->Base USDC)',
        extendedTimeoutMultiplier: 2,
      },
      async ({ driver }: { driver: Driver }) => {
        console.log(`\n${'='.repeat(80)}`);
        console.log('[TEST] Starting popular-network bridge execution test');
        console.log(`${'='.repeat(80)}\n`);

        console.log('[TEST] Logging in to wallet...');
        await loginWithoutBalanceValidation(driver);
        const homePage = new HomePage(driver);
        await homePage.checkPageIsLoaded();
        // Extended delay to ensure wallet fully syncs and initializes
        console.log('[TEST] Waiting for wallet to fully sync and initialize...');
        await driver.delay(PROD_DELAYS.API_RESPONSE * 3);

        console.log('[TEST] Importing funded account (PRIVATE_KEY_FROM)...');
        const privateKeyFrom = getRequiredE2EEnv('PRIVATE_KEY_FROM');
        await importSingleFundedAccount(driver, privateKeyFrom);

        console.log('[TEST] Ensuring Base USDC token is imported...');
        await ensureBaseUsdcImported(driver);

        // Return to Monad for route 1 start.
        await switchToNetwork(driver, 'Monad');

        for (const route of BRIDGE_ROUTES) {
          const routeResult: SwapRouteResult = {
            route: route.label,
            fromSymbol: route.fromSymbol,
            toSymbol: route.toSymbol,
            fromAmount: '',
            toAmount: '',
            validations: [],
            status: 'failed',
          };

          const recordValidation = (
            name: string,
            status: SwapValidationResult['status'],
            details?: string,
          ) => {
            routeResult.validations?.push({ name, status, details });
          };

          console.log(`\n[TEST] ── Route: ${route.label} ──`);

          try {
            console.log(
              `[TEST] Selecting source network: ${route.sourceNetwork}`,
            );
            await switchToNetwork(driver, route.sourceNetwork);
            recordValidation(
              'Source network selected',
              'passed',
              route.sourceNetwork,
            );

            await performSwapFlow(driver, {
              sourceTokenSymbol: route.fromSymbol,
              destinationTokenAddress: route.destinationAddress,
              destinationTokenSymbol: route.toSymbol,
              fromAmount: route.fromAmount,
            });
            recordValidation('Swap flow configured', 'passed');

            if (route.hardFailOnInsufficientFunds) {
              await assertNoInsufficientFunds(driver, route.label);
              recordValidation('No insufficient funds', 'passed');
            }

            await waitForSwapQuoteReady(driver);
            recordValidation('Quote ready', 'passed');

            await assertCtaFeeText(driver);
            recordValidation('CTA fee text', 'passed');

            const { fromAmount, toAmount } = await captureSwapAmounts(driver);
            routeResult.fromAmount = fromAmount;
            routeResult.toAmount = toAmount;

            const activityTransitionResult =
              await submitBridgeAndWaitForActivity(driver, route);
            if (activityTransitionResult.transitionToSwap) {
              recordValidation(
                'Activity transition Bridged->Swap',
                'passed',
                `Activity label reached Swap for ${route.fromSymbol} -> ${route.toSymbol}`,
              );
            } else {
              recordValidation(
                'Activity transition Bridged->Swap',
                'warning',
                `ALERT: Activity label did not transition to Swap within ${BRIDGE_TO_SWAP_TRANSITION_TIMEOUT}ms`,
              );
            }

            await assertActivityPrimaryCurrency(
              driver,
              `-${fromAmount} ${route.fromSymbol}`,
            );
            recordValidation(
              'Activity amount',
              'passed',
              `-${fromAmount} ${route.fromSymbol}`,
            );

            const activityStatus =
              await assertActivityHasAcceptedStatus(driver);
            recordValidation('Activity status', 'passed', activityStatus);

            await openLatestBridgeActivityRecord(driver, route);
            recordValidation('Activity record opened', 'passed');

            const detailResult = await assertBridgeDetailsPage(
              driver,
              route,
              fromAmount,
            );
            recordValidation(
              'Bridge details validated',
              'passed',
              detailResult.details.join(' | '),
            );

            await navigateBackToActivityTab(driver);
            recordValidation(
              'Returned to activity tab',
              'passed',
              route.homeNetworkFilter,
            );

            await resetToTokensHomeForRoute(driver, route);
            recordValidation(
              'Returned to tokens home',
              'passed',
              route.homeNetworkFilter,
            );

            routeResult.status = 'passed';
            console.log(`[TEST] ✅ Route passed: ${route.label}`);
          } catch (error) {
            routeResult.status = 'failed';
            routeResult.error = String(error);
            recordValidation('Route execution error', 'failed', String(error));
            console.error(`[TEST] ❌ Route failed: ${route.label}`);
            console.error(error);

            const recovered = await recoverToHome(driver);
            if (!recovered) {
              routeResults.push(routeResult);
              break;
            }
          }

          routeResults.push(routeResult);
        }

        const failedRoutes = routeResults.filter((r) => r.status === 'failed');
        if (failedRoutes.length > 0) {
          throw new Error(
            `${failedRoutes.length}/${routeResults.length} bridge route(s) failed: ${failedRoutes
              .map((r) => r.route)
              .join(', ')}`,
          );
        }
      },
    );
  });
});
