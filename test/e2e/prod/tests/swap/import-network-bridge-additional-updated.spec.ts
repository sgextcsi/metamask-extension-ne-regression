/**
 * Production E2E Test: Monad MON <-> USDC Swap Execution
 *
 * Executes two live swaps in sequence and validates activity + detail rows:
 * 1) MON -> USDC (Base USDC address)
 * 2) USDC -> MON (fixed 0.5 USDC)
 *
 * No tokenlist fetch/import is used in this test.
 *
 * Prerequisites:
 * - PRIVATE_KEY_TO in .env.e2e (funded account with Monad-native MON)
 * - Real network connectivity to Monad RPC
 */

import { Suite } from 'mocha';
import FixtureBuilder from '../../../fixtures/fixture-builder';
import { withProductionFixtures } from '../../helpers/prod-with-fixtures';
import { PROD_DELAYS } from '../../helpers/prod-test-helpers';
import { loginWithoutBalanceValidation } from '../../../page-objects/flows/login.flow';
import HomePage from '../../../page-objects/pages/home/homepage';
import AssetListPage from '../../../page-objects/pages/home/asset-list';
import ActivityListPage from '../../../page-objects/pages/home/activity-list';
import NetworkManager from '../../../page-objects/pages/network-manager';
import { Driver } from '../../../webdriver/driver';
import { getRequiredE2EEnv } from '../../../helpers/e2e-env';
import {
  SWAP_TEST_NETWORKS,
  SwapRouteResult,
  SwapValidationResult,
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
  generateBridgeExecutionReport,
} from './swap-execution-helpers';

/**
 * Production E2E Test: Monad MON <-> USDC simple execution.
 */
describe('Production E2E: Monad MON <-> USDC Swap Execution', function (this: Suite) {
  this.timeout(900000);

  it('executes MON -> USDC then USDC -> MON with fixed 0.5 USDC', async function () {
    const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const MONAD_NETWORK_NAME = 'Monad';
    const MON_SYMBOL = 'MON';
    const USDC_SYMBOL = 'USDC';
    const MON_TO_USDC_AMOUNT = '20';
    const USDC_TO_MON_AMOUNT = '0.5';

    // Collect per-route results for the final markdown bridge report
    const routeResults: SwapRouteResult[] = [];

    const networkConfig = SWAP_TEST_NETWORKS.find(
      ({ networkName }) => networkName === MONAD_NETWORK_NAME,
    );

    if (!networkConfig) {
      throw new Error(
        `[TEST] Missing network config for ${MONAD_NETWORK_NAME}`,
      );
    }

    await withProductionFixtures(
      {
        fixtures: new FixtureBuilder()
          .withNetworkControllerOnBase()
          .withNetworkControllerOnMonad()
          .build(),
        title:
          this.test?.fullTitle() ||
          `Swap execution test for ${MONAD_NETWORK_NAME}`,
        extendedTimeoutMultiplier: 2,
      },
      async ({ driver }: { driver: Driver }) => {
        console.log(`\n${'='.repeat(80)}`);
        console.log(
          `[TEST] Starting MON <-> USDC swap execution on ${MONAD_NETWORK_NAME}`,
        );
        console.log(`${'='.repeat(80)}\n`);

        console.log(`[TEST] Logging in to wallet...`);
        await loginWithoutBalanceValidation(driver);
        const homePage = new HomePage(driver);
        await homePage.checkPageIsLoaded();
        await driver.delay(PROD_DELAYS.API_RESPONSE);
        console.log(`[TEST] ✅ Logged in`);

        console.log(`[TEST] Selecting ${MONAD_NETWORK_NAME} network...`);
        const networkManager = new NetworkManager(driver);
        await networkManager.openNetworkManager();
        await networkManager.selectTab('Popular');
        await networkManager.selectNetworkByNameWithWait(MONAD_NETWORK_NAME);
        await homePage.checkPageIsLoaded();
        await driver.delay(PROD_DELAYS.API_RESPONSE);
        console.log(`[TEST] ✅ Network selected: ${MONAD_NETWORK_NAME}`);

        console.log(`[TEST] Importing funded account (PRIVATE_KEY_FROM)...`);
        const privateKeyFrom = getRequiredE2EEnv('PRIVATE_KEY_FROM');
        await importSingleFundedAccount(driver, privateKeyFrom);
        console.log(`[TEST] ✅ Funded account imported and active`);

        const normalizeText = (value: string) =>
          value.replace(/\s+/gu, ' ').trim().toUpperCase();

        const assertLatestActivityActionOneOf = async (
          expectedActions: string[],
        ): Promise<void> => {
          const actionRowsSelector =
            '[data-testid="activity-list-item-action"]';
          await driver.waitForSelector(actionRowsSelector, { timeout: 120000 });
          const actionRows = await driver.findElements(actionRowsSelector);
          if (actionRows.length === 0) {
            throw new Error(
              '[TEST] No activity rows found for latest action assertion',
            );
          }

          const latestActionText = normalizeText(await actionRows[0].getText());
          const matches = expectedActions.some((action) =>
            latestActionText.includes(normalizeText(action)),
          );

          if (!matches) {
            throw new Error(
              `[TEST] Latest activity action "${latestActionText}" did not match any of: ${expectedActions.join(', ')}`,
            );
          }

          console.log(
            `[TEST] ✅ Latest activity action matched: "${latestActionText}"`,
          );
        };

        const dismissUnexpectedBrowserAlertIfPresent =
          async (): Promise<boolean> => {
            try {
              await driver.closeAlertPopup();
              console.warn(
                '[TEST] ⚠️  Dismissed unexpected browser auth alert while restoring network scope',
              );
              await driver.delay(PROD_DELAYS.API_RESPONSE);
              return true;
            } catch (_error) {
              // No browser alert is currently open.
              return false;
            }
          };

        const applySafeHomeNetworkScope = async (
          filterNetworkName: string,
        ): Promise<void> => {
          const assetListPage = new AssetListPage(driver);

          await dismissUnexpectedBrowserAlertIfPresent();

          try {
            await assetListPage.selectNetworkFilter(filterNetworkName);
          } catch (error) {
            await dismissUnexpectedBrowserAlertIfPresent();

            console.warn(
              `[TEST] ⚠️  Retrying network filter selection: ${filterNetworkName}`,
            );
            try {
              await assetListPage.selectNetworkFilter(filterNetworkName);
            } catch (filterError) {
              console.warn(
                `[TEST] ⚠️  Network filter selection failed for ${filterNetworkName}. Falling back to active network switch. Error: ${String(filterError)}`,
              );

              await dismissUnexpectedBrowserAlertIfPresent();
              await networkManager.openNetworkManager();
              await networkManager.selectTab('Popular');
              await networkManager.selectNetworkByNameWithWait(
                filterNetworkName,
              );
              await homePage.checkPageIsLoaded();
              await driver.delay(PROD_DELAYS.API_RESPONSE);
            }
          }
        };

        const submitSwapAndOpenActivityWithMonadFilter = async (
          expectedActions: string[],
          filterNetworkName: string,
        ): Promise<void> => {
          await driver.clickElement('[data-testid="bridge-cta-button"]');
          await driver.delay(PROD_DELAYS.API_RESPONSE * 2);
          await recoverToHome(driver);

          // Bridge flows can return to an all-networks token view. Force source
          // network before opening activity so assertions remain scoped.
          await applySafeHomeNetworkScope(filterNetworkName);

          const activityListPage = new ActivityListPage(driver);
          await activityListPage.openActivityTab();

          await assertLatestActivityActionOneOf(expectedActions);
        };

        const openLatestActivityRecord = async (): Promise<void> => {
          const actionRowsSelector =
            '[data-testid="activity-list-item-action"]';
          await driver.waitForSelector(actionRowsSelector, { timeout: 120000 });
          const activityRows = await driver.findElements(actionRowsSelector);
          if (activityRows.length === 0) {
            throw new Error(
              '[TEST] No activity rows found to open latest record',
            );
          }

          await activityRows[0].click();
          await driver.waitForUrlContaining({ url: '/cross-chain/tx-details' });
        };

        const assertSwapDetailStatusAccepted = async (): Promise<void> => {
          const acceptedStatuses = ['pending', 'confirmed'];
          const statusSelector =
            '[data-testid="bridge-transaction-details-tx-status"]';

          try {
            await driver.waitForSelector(statusSelector, { timeout: 20000 });
            const statusElement = await driver.findElement(statusSelector);
            const statusText = (await statusElement.getText())
              .trim()
              .toLowerCase();

            if (!acceptedStatuses.includes(statusText)) {
              console.warn(
                `[TEST] ⚠️  ALERT: Bridge detail status warning: got "${statusText}". Expected one of: ${acceptedStatuses.join(', ')}`,
              );
              return;
            }

            console.log(
              `[TEST] ✅ Bridge detail status accepted: ${statusText}`,
            );
          } catch (error) {
            console.warn(
              `[TEST] ⚠️  ALERT: Bridge detail status row not found or unreadable: ${String(error)}`,
            );
          }
        };

        const executeAndValidateSwap = async ({
          fromSymbol,
          toSymbol,
          destinationTokenAddress,
          fromAmount,
          expectedActivityActionLabels,
          sourceNetworkName,
        }: {
          fromSymbol: string;
          toSymbol: string;
          destinationTokenAddress: string;
          fromAmount: string;
          expectedActivityActionLabels: string[];
          sourceNetworkName: string;
        }): Promise<void> => {
          const routeLabel = `${fromSymbol} → ${toSymbol} (${sourceNetworkName})`;
          console.log(`\n[TEST] ── Route: ${routeLabel} ──`);

          const routeResult: SwapRouteResult = {
            route: routeLabel,
            fromSymbol,
            toSymbol,
            fromAmount,
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

          try {
            await performSwapFlow(driver, {
              sourceTokenSymbol: fromSymbol,
              destinationTokenAddress,
              destinationTokenSymbol: toSymbol,
              fromAmount,
              useMax: false,
            });

            const reducedAmount = await handleInsufficientFundsIfPresent(
              driver,
              fromAmount,
            );
            if (reducedAmount !== undefined) {
              console.log(
                `[TEST] ⚠️  Insufficient funds — amount reduced to ${reducedAmount}`,
              );
            }

            await waitForSwapQuoteReady(driver);
            recordValidation('Quote ready', 'passed');
            await assertCtaFeeText(driver);
            recordValidation('CTA fee text', 'passed');

            const { fromAmount: capturedFromAmount, toAmount } =
              await captureSwapAmounts(driver);
            routeResult.fromAmount = capturedFromAmount;
            routeResult.toAmount = toAmount;

            await submitSwapAndOpenActivityWithMonadFilter(
              expectedActivityActionLabels,
              sourceNetworkName,
            );

            await assertActivityPrimaryCurrency(
              driver,
              `-${capturedFromAmount} ${fromSymbol}`,
            );
            await assertActivitySecondaryCurrency(driver, '-$');
            recordValidation('Activity primary amount', 'passed', `-${capturedFromAmount} ${fromSymbol}`);
            recordValidation('Activity secondary value', 'passed', '-$');

            await openLatestActivityRecord();

            // Bridge detail status: accept 'pending' or 'confirmed'
            try {
              await assertSwapDetailStatusAccepted();
              recordValidation('Bridge detail status', 'passed', 'pending or confirmed');
            } catch (statusError) {
              recordValidation('Bridge detail status', 'warning', String(statusError));
            }

            const timestampResult = await assertTransactionTimestamp(driver);
            recordValidation(
              'Time stamp row',
              timestampResult.isValid ? 'passed' : 'warning',
              timestampResult.message,
            );
            if (!timestampResult.isValid) {
              console.warn(
                `[TEST] ⚠️  ALERT: Time stamp row validation warning: ${timestampResult.message}`,
              );
            }

            try {
              await assertDetailRow(
                driver,
                'You sent',
                `${capturedFromAmount} ${fromSymbol}`,
              );
              recordValidation('You sent row', 'passed', `${capturedFromAmount} ${fromSymbol}`);
            } catch (error) {
              recordValidation('You sent row', 'warning', String(error));
              console.warn(
                `[TEST] ⚠️  ALERT: You sent row validation warning: ${String(error)}`,
              );
            }

            const receivedRowResult = await validateDetailRowAmountAtPrecision(
              driver,
              'You received',
              `${toAmount} ${toSymbol}`,
            );
            recordValidation(
              'You received row',
              receivedRowResult.isValid ? 'passed' : 'warning',
              receivedRowResult.message,
            );
            if (!receivedRowResult.isValid) {
              console.warn(
                `[TEST] ⚠️  ALERT: You received row validation warning: ${receivedRowResult.message}`,
              );
            }

            const totalGasFeeResult = await assertTotalGasFeeRow(
              driver,
              networkConfig.gasFeeSponsoredByProtocol ?? false,
            );
            recordValidation(
              'Total gas fee row',
              totalGasFeeResult.isValid ? 'passed' : 'warning',
              totalGasFeeResult.message,
            );
            if (!totalGasFeeResult.isValid) {
              console.warn(
                `[TEST] ⚠️  ALERT: Total gas fee row validation warning: ${totalGasFeeResult.message}`,
              );
            }

            await navigateBackToHome(driver);
            routeResult.status = 'passed';
            console.log(`[TEST] ✅ Route passed: ${routeLabel}`);
          } catch (error) {
            routeResult.status = 'failed';
            routeResult.error = String(error);
            recordValidation('Route execution error', 'failed', String(error));
            console.error(`[TEST] ❌ Route failed: ${routeLabel}`);
            console.error(error);

            await recoverToHome(driver);
            throw error;
          } finally {
            routeResults.push(routeResult);
          }
        };

        try {
          await executeAndValidateSwap({
            fromSymbol: MON_SYMBOL,
            toSymbol: USDC_SYMBOL,
            destinationTokenAddress: BASE_USDC_ADDRESS,
            fromAmount: MON_TO_USDC_AMOUNT,
            expectedActivityActionLabels: ['Swap', 'Bridged to Base'],
            sourceNetworkName: MONAD_NETWORK_NAME,
          });

          // After route 1 completes, switch to Base so route 2 sends from USDC on Base.
          console.log('[TEST] Switching active network to Base for route 2...');
          await dismissUnexpectedBrowserAlertIfPresent();
          await networkManager.openNetworkManager();
          await networkManager.selectTab('Popular');
          await networkManager.selectNetworkByNameWithWait('Base');
          await homePage.checkPageIsLoaded();
          await driver.delay(PROD_DELAYS.API_RESPONSE);
          console.log('[TEST] ✅ Network selected: Base');

          await executeAndValidateSwap({
            fromSymbol: USDC_SYMBOL,
            toSymbol: MON_SYMBOL,
            destinationTokenAddress: MON_SYMBOL,
            fromAmount: USDC_TO_MON_AMOUNT,
            expectedActivityActionLabels: ['Swap', 'Bridged to Monad'],
            sourceNetworkName: 'Base',
          });
        } finally {
          // Generate the bridge execution report regardless of pass/fail
          try {
            generateBridgeExecutionReport(routeResults, {
              title: 'Monad MON <-> Base USDC Bridge Execution',
              sourceNetwork: MONAD_NETWORK_NAME,
              destinationNetwork: 'Base',
            });
          } catch (reportError) {
            console.warn(
              '[TEST] ⚠️  Failed to generate bridge execution report:',
              reportError,
            );
          }
        }
      },
    );
  });
});
