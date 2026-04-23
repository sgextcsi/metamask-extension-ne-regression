/**
 * Production E2E Test: Monad MON <-> Base USDC Bridge Execution
 *
 * Executes two live bridge operations in sequence and validates activity plus
 * bridge detail rows:
 * 1) MON -> USDC (Monad -> Base)
 * 2) USDC -> MON (Base -> Monad)
 *
 * This spec intentionally avoids the token-home network filter flow after
 * bridge submission because that path can trigger unrelated RPC auth prompts.
 */

import { Suite } from 'mocha';
import FixtureBuilder from '../../../fixtures/fixture-builder';
import { withProductionFixtures } from '../../helpers/prod-with-fixtures';
import { PROD_DELAYS } from '../../helpers/prod-test-helpers';
import { loginWithoutBalanceValidation } from '../../../page-objects/flows/login.flow';
import HomePage from '../../../page-objects/pages/home/homepage';
import ActivityListPage from '../../../page-objects/pages/home/activity-list';
import NetworkManager from '../../../page-objects/pages/network-manager';
import { Driver } from '../../../webdriver/driver';
import { getRequiredE2EEnv } from '../../../helpers/e2e-env';
import { CHAIN_IDS } from '../../../../../shared/constants/network';
import {
  getBridgeExecutionConfig,
  getNetworkSwapConfig,
  BridgeExecutionRouteConfig,
} from './network-swap-config';
import { performSwapFlow } from './swap-quotation-helpers';
import {
  importSingleFundedAccount,
  waitForSwapQuoteReady,
  assertCtaFeeText,
  captureSwapAmounts,
  assertActivityPrimaryCurrency,
  assertActivitySecondaryCurrency,
  assertDetailRow,
  validateDetailRowAmountAtPrecision,
  assertTransactionTimestamp,
  assertTotalGasFeeRow,
  handleInsufficientFundsIfPresent,
  navigateBackToHome,
  recoverToHome,
} from './swap-execution-helpers';

const ACTIVITY_ACTION_SELECTOR = '[data-testid="activity-list-item-action"]';
const BRIDGE_CTA_SELECTOR = '[data-testid="bridge-cta-button"]';
const BRIDGE_STATUS_SELECTOR =
  '[data-testid="bridge-transaction-details-tx-status"]';
const BRIDGE_DETAILS_URL = '/cross-chain/tx-details';
const BRIDGE_SCENARIO_ID = 'monad-base-usdc';
const ACTIVITY_TIMEOUT = 240000;

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toUpperCase();
}

async function dismissUnexpectedBrowserAlertIfPresent(
  driver: Driver,
): Promise<boolean> {
  try {
    await driver.closeAlertPopup();
    console.warn(
      '[TEST] ⚠️  Dismissed unexpected browser auth alert during bridge flow',
    );
    await driver.delay(PROD_DELAYS.API_RESPONSE);
    return true;
  } catch (_error) {
    return false;
  }
}

async function switchToNetwork(
  driver: Driver,
  networkName: string,
): Promise<void> {
  const homePage = new HomePage(driver);
  const networkManager = new NetworkManager(driver);

  await dismissUnexpectedBrowserAlertIfPresent(driver);
  await networkManager.openNetworkManager();
  await networkManager.selectTab('Popular');
  await networkManager.selectNetworkByNameWithWait(networkName);
  await homePage.checkPageIsLoaded();
  await driver.delay(PROD_DELAYS.API_RESPONSE);
}

async function assertNoInsufficientFunds(
  driver: Driver,
  route: BridgeExecutionRouteConfig,
): Promise<void> {
  try {
    await driver.waitForSelector(
      {
        css: BRIDGE_CTA_SELECTOR,
        text: 'Insufficient funds',
      },
      { timeout: 4000 },
    );
    throw new Error(
      `[TEST] Hard failure for ${route.label}: insufficient funds shown for bridge route`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Hard failure for')) {
      throw error;
    }
  }
}

async function openActivityTab(driver: Driver): Promise<void> {
  const activityListPage = new ActivityListPage(driver);
  await dismissUnexpectedBrowserAlertIfPresent(driver);
  await activityListPage.openActivityTab();
  await driver.delay(PROD_DELAYS.API_RESPONSE);
}

async function waitForAcceptedActivityAction(
  driver: Driver,
  expectedActions: string[],
): Promise<string> {
  let matchedText = '';
  const normalizedExpectedActions = expectedActions.map(normalizeText);
  const activityActionLocator = driver.buildLocator(
    ACTIVITY_ACTION_SELECTOR,
  ) as never;

  await driver.waitUntil(
    async () => {
      await dismissUnexpectedBrowserAlertIfPresent(driver);
      const actionRows = await driver.driver.findElements(
        activityActionLocator,
      );
      for (const row of actionRows) {
        const rowText = normalizeText(await row.getText());
        const isMatch = normalizedExpectedActions.some((expectedAction) =>
          rowText.includes(expectedAction),
        );
        if (isMatch) {
          matchedText = rowText;
          return true;
        }
      }
      return false;
    },
    { timeout: ACTIVITY_TIMEOUT, interval: 2000 },
  );

  if (!matchedText) {
    throw new Error(
      `[TEST] Latest bridge activity did not match any expected action: ${expectedActions.join(', ')}`,
    );
  }

  console.log(`[TEST] ✅ Latest activity action matched: "${matchedText}"`);
  return matchedText;
}

async function openLatestActivityRecord(
  driver: Driver,
  expectedActions: string[],
): Promise<void> {
  const normalizedExpectedActions = expectedActions.map(normalizeText);
  const activityActionLocator = driver.buildLocator(
    ACTIVITY_ACTION_SELECTOR,
  ) as never;
  await driver.waitForSelector(ACTIVITY_ACTION_SELECTOR, {
    timeout: ACTIVITY_TIMEOUT,
  });

  const actionRows = await driver.driver.findElements(activityActionLocator);
  for (const row of actionRows) {
    const rowText = normalizeText(await row.getText());
    const isMatch = normalizedExpectedActions.some((expectedAction) =>
      rowText.includes(expectedAction),
    );
    if (isMatch) {
      await row.click();
      await driver.waitForUrlContaining({ url: BRIDGE_DETAILS_URL });
      return;
    }
  }

  throw new Error(
    `[TEST] Could not open a matching bridge activity row for: ${expectedActions.join(', ')}`,
  );
}

async function getDetailRowText(
  driver: Driver,
  rowLabel: string,
): Promise<string> {
  const xpath = `//*[@data-testid="transaction-detail-row"]/p[text()='${rowLabel}']/..`;
  const rowElement = await driver.findElement({ xpath });
  return await rowElement.getText();
}

async function assertBridgeDetailsPage(
  driver: Driver,
  route: BridgeExecutionRouteConfig,
  fromAmount: string,
  toAmount: string,
  gasFeeSponsoredByProtocol: boolean,
): Promise<void> {
  await driver.waitForUrlContaining({ url: BRIDGE_DETAILS_URL });
  await driver.waitForSelector({ text: 'Bridge details' });

  const statusElement = await driver.findElement(BRIDGE_STATUS_SELECTOR);
  const statusText = (await statusElement.getText()).trim().toLowerCase();
  const acceptedStatuses = route.acceptedDetailStatuses ?? [
    'pending',
    'confirmed',
  ];

  if (!acceptedStatuses.includes(statusText)) {
    throw new Error(
      `[TEST] Bridge detail status ${statusText} did not match expected statuses: ${acceptedStatuses.join(', ')}`,
    );
  }

  const bridgingRowText = await getDetailRowText(driver, 'Bridging');
  if (
    !bridgingRowText.includes(route.sourceNetworkName) ||
    !bridgingRowText.includes(route.destinationNetworkName)
  ) {
    throw new Error(`[TEST] Bridging row mismatch: ${bridgingRowText}`);
  }

  await assertDetailRow(
    driver,
    'You sent',
    `${fromAmount} ${route.fromSymbol}`,
  );

  const receivedRowResult = await validateDetailRowAmountAtPrecision(
    driver,
    'You received',
    `${toAmount} ${route.toSymbol}`,
  );
  if (!receivedRowResult.isValid) {
    throw new Error(
      `[TEST] You received row validation failed: ${receivedRowResult.message}`,
    );
  }

  const timestampResult = await assertTransactionTimestamp(driver);
  if (!timestampResult.isValid) {
    throw new Error(
      `[TEST] Time stamp validation failed: ${timestampResult.message}`,
    );
  }

  const totalGasFeeResult = await assertTotalGasFeeRow(
    driver,
    gasFeeSponsoredByProtocol,
  );
  if (!totalGasFeeResult.isValid) {
    throw new Error(
      `[TEST] Total gas fee validation failed: ${totalGasFeeResult.message}`,
    );
  }
}

async function submitBridgeAndOpenActivity(
  driver: Driver,
  route: BridgeExecutionRouteConfig,
): Promise<void> {
  await driver.clickElement(BRIDGE_CTA_SELECTOR);
  await driver.delay(PROD_DELAYS.API_RESPONSE * 2);
  await recoverToHome(driver);
  await dismissUnexpectedBrowserAlertIfPresent(driver);
  await openActivityTab(driver);
  await waitForAcceptedActivityAction(
    driver,
    route.expectedActivityActionLabels,
  );
}

describe('Production E2E: Monad MON <-> Base USDC Bridge Execution', function (this: Suite) {
  this.timeout(900000);

  it('executes MON -> USDC then USDC -> MON bridge routes', async function () {
    const bridgeConfig = getBridgeExecutionConfig(BRIDGE_SCENARIO_ID);
    if (!bridgeConfig) {
      throw new Error(
        `[TEST] Missing bridge config for scenario ${BRIDGE_SCENARIO_ID}`,
      );
    }

    const monadNetworkConfig = getNetworkSwapConfig('Mon');
    if (!monadNetworkConfig) {
      throw new Error('[TEST] Missing Monad network config');
    }

    await withProductionFixtures(
      {
        fixtures: new FixtureBuilder()
          .withNetworkControllerOnBase()
          .withNetworkControllerOnMonad()
          .withEnabledNetworks({
            eip155: {
              [CHAIN_IDS.BASE]: true,
              [CHAIN_IDS.MONAD]: true,
            },
          })
          .build(),
        title: this.test?.fullTitle() || bridgeConfig.title,
        extendedTimeoutMultiplier: 2,
      },
      async ({ driver }: { driver: Driver }) => {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`[TEST] Starting bridge execution: ${bridgeConfig.title}`);
        console.log(`${'='.repeat(80)}\n`);

        await loginWithoutBalanceValidation(driver);
        const homePage = new HomePage(driver);
        await homePage.checkPageIsLoaded();
        await driver.delay(PROD_DELAYS.API_RESPONSE);

        await switchToNetwork(driver, bridgeConfig.initialNetworkName);

        const privateKeyFrom = getRequiredE2EEnv('PRIVATE_KEY_FROM');
        await importSingleFundedAccount(driver, privateKeyFrom);

        for (const route of bridgeConfig.routes) {
          console.log(`\n[TEST] ── Route: ${route.label} ──`);

          try {
            await switchToNetwork(driver, route.sourceNetworkName);

            await performSwapFlow(driver, {
              sourceTokenSymbol: route.fromSymbol,
              destinationTokenAddress: route.destinationTokenAddress,
              destinationTokenSymbol: route.toSymbol,
              fromAmount: route.fromAmount,
              useMax: false,
            });

            if (route.hardFailOnInsufficientFunds) {
              await assertNoInsufficientFunds(driver, route);
            } else {
              await handleInsufficientFundsIfPresent(driver, route.fromAmount);
            }

            await waitForSwapQuoteReady(driver);
            await assertCtaFeeText(driver);

            const { fromAmount, toAmount } = await captureSwapAmounts(driver);

            await submitBridgeAndOpenActivity(driver, route);
            await assertActivityPrimaryCurrency(
              driver,
              `-${fromAmount} ${route.fromSymbol}`,
            );
            await assertActivitySecondaryCurrency(driver, '-$');

            await openLatestActivityRecord(
              driver,
              route.expectedActivityActionLabels,
            );
            await assertBridgeDetailsPage(
              driver,
              route,
              fromAmount,
              toAmount,
              monadNetworkConfig.gasFeeSponsoredByProtocol ?? false,
            );

            await navigateBackToHome(driver);
            console.log(`[TEST] ✅ Route passed: ${route.label}`);
          } catch (error) {
            console.error(`[TEST] ❌ Route failed: ${route.label}`);
            console.error(error);
            await recoverToHome(driver);
            throw error;
          }
        }
      },
    );
  });
});
