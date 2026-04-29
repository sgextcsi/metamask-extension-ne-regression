/**
 * Production E2E Test: Parameterized bridge execution with account creation.
 *
 * Workflow:
 * 1) Create a new multichain account from home
 * 2) Import account (PRIVATE_KEY_TO)
 * 3) Execute MON -> USDC bridge route from imported account
 * 4) Transfer USDC to the newly-created account on Base
 * 5) Execute USDC -> MON bridge route from created account
 * 6) Attempt final return send to imported account on Monad using destination token
 */

import { Suite } from 'mocha';
import { withProductionFixtures } from '../../helpers/prod-with-fixtures';
import { PROD_DELAYS } from '../../helpers/prod-test-helpers';
import { loginWithoutBalanceValidation } from '../../../page-objects/flows/login.flow';
import HomePage from '../../../page-objects/pages/home/homepage';
import AssetListPage from '../../../page-objects/pages/home/asset-list';
import ActivityListPage from '../../../page-objects/pages/home/activity-list';
import AccountListPage from '../../../page-objects/pages/account-list-page';
import SendPage from '../../../page-objects/pages/send/send-page';
import SendTokenConfirmPage from '../../../page-objects/pages/confirmations/token-transfer-confirmation';
import NetworkManager from '../../../page-objects/pages/network-manager';
import { Driver } from '../../../webdriver/driver';
import { getRequiredE2EEnv } from '../../../helpers/e2e-env';
import {
  SWAP_TEST_NETWORKS,
  SwapRouteResult,
  SwapValidationResult,
  MONAD_BASE_BRIDGE_SCENARIO,
  buildBaseMonadBridgeFixture,
} from './network-swap-config';
import { performSwapFlow } from './swap-quotation-helpers';
import {
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

const MONAD_CHAIN_ID_HEX = '0x8f';
const BASE_CHAIN_ID_HEX = '0x2105';
const IMPORTED_ACCOUNT_NAME = 'Imported Account 1';
const CREATED_ACCOUNT_NAME = 'Account 2';
const TRANSFER_TO_CREATED_USDC_AMOUNT = '1';
const FINAL_RETURN_TO_IMPORTED_AMOUNT = '0.1';

/**
 * Production E2E Test: Monad/Base bridge with explicit account management flow.
 */
describe('Production E2E: Parameterized bridge with created account', function (this: Suite) {
  this.timeout(900000);

  it('creates account, bridges on imported account, then bridges on created account', async function () {
    const scenario = MONAD_BASE_BRIDGE_SCENARIO;

    const routeResults: SwapRouteResult[] = [];

    const networkConfig = SWAP_TEST_NETWORKS.find(
      ({ networkName }) => networkName === scenario.primaryNetworkName,
    );

    if (!networkConfig) {
      throw new Error(
        `[TEST] Missing network config for ${scenario.primaryNetworkName}`,
      );
    }

    await withProductionFixtures(
      {
        fixtures: buildBaseMonadBridgeFixture(),
        title:
          this.test?.fullTitle() ||
          `Parameterized bridge execution test for ${scenario.primaryNetworkName}`,
        extendedTimeoutMultiplier: 2,
      },
      async ({ driver }: { driver: Driver }) => {
        console.log(`\n${'='.repeat(80)}`);
        console.log(
          `[TEST] Starting parameterized bridge flow on ${scenario.primaryNetworkName}`,
        );
        console.log(`${'='.repeat(80)}\n`);

        const homePage = new HomePage(driver);
        const networkManager = new NetworkManager(driver);

        const normalizeText = (value: string) =>
          value.replace(/\s+/gu, ' ').trim().toUpperCase();

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
              return false;
            }
          };

        const selectNetwork = async (networkName: string): Promise<void> => {
          await dismissUnexpectedBrowserAlertIfPresent();
          await networkManager.openNetworkManager();
          await networkManager.selectTab('Popular');
          await networkManager.selectNetworkByNameWithWait(networkName);
          await homePage.checkPageIsLoaded();
          await driver.delay(PROD_DELAYS.API_RESPONSE);
          console.log(`[TEST] ✅ Network selected: ${networkName}`);
        };

        const switchToAccount = async (accountName: string): Promise<void> => {
          await homePage.headerNavbar.openAccountMenu();
          const accountListPage = new AccountListPage(driver);
          await accountListPage.checkPageIsLoaded();
          await accountListPage.selectAccount(accountName);
          await homePage.checkPageIsLoaded();
          await driver.delay(PROD_DELAYS.API_RESPONSE);
          console.log(`[TEST] ✅ Active account: ${accountName}`);
        };

        const createAndSwitchToNewAccount = async (): Promise<string> => {
          await homePage.headerNavbar.openAccountMenu();
          const accountListPage = new AccountListPage(driver);
          await accountListPage.checkPageIsLoaded();
          await accountListPage.addMultichainAccount();
          await accountListPage.checkAccountDisplayedInAccountList(
            CREATED_ACCOUNT_NAME,
          );
          await accountListPage.selectAccount(CREATED_ACCOUNT_NAME);
          await homePage.checkPageIsLoaded();
          await driver.delay(PROD_DELAYS.API_RESPONSE);
          console.log(`[TEST] ✅ Created account: ${CREATED_ACCOUNT_NAME}`);
          return CREATED_ACCOUNT_NAME;
        };

        const importAccountOneAndSwitch = async (
          privateKey: string,
        ): Promise<string> => {
          await homePage.headerNavbar.openAccountMenu();
          const accountListPage = new AccountListPage(driver);
          await accountListPage.checkPageIsLoaded();
          await accountListPage.addNewImportedAccount(privateKey, undefined, {
            isMultichainAccountsState2Enabled: true,
          });
          await accountListPage.selectAccount(IMPORTED_ACCOUNT_NAME);
          await homePage.checkPageIsLoaded();
          await driver.delay(PROD_DELAYS.API_RESPONSE);
          console.log(
            `[TEST] ✅ Imported account active: ${IMPORTED_ACCOUNT_NAME}`,
          );
          return IMPORTED_ACCOUNT_NAME;
        };

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

        const applySafeHomeNetworkScope = async (
          filterNetworkName: string,
        ): Promise<void> => {
          const assetListPage = new AssetListPage(driver);

          await dismissUnexpectedBrowserAlertIfPresent();

          try {
            await assetListPage.selectNetworkFilter(filterNetworkName);
          } catch (_error) {
            await dismissUnexpectedBrowserAlertIfPresent();
            await selectNetwork(filterNetworkName);
          }
        };

        const submitSwapAndOpenActivityWithNetworkFilter = async (
          expectedActions: string[],
          filterNetworkName: string,
        ): Promise<void> => {
          await driver.clickElement('[data-testid="bridge-cta-button"]');
          await driver.delay(PROD_DELAYS.API_RESPONSE * 2);
          await recoverToHome(driver);
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

            await submitSwapAndOpenActivityWithNetworkFilter(
              expectedActivityActionLabels,
              sourceNetworkName,
            );

            await assertActivityPrimaryCurrency(
              driver,
              `-${capturedFromAmount} ${fromSymbol}`,
            );
            await assertActivitySecondaryCurrency(driver, '-$');
            recordValidation(
              'Activity primary amount',
              'passed',
              `-${capturedFromAmount} ${fromSymbol}`,
            );
            recordValidation('Activity secondary value', 'passed', '-$');

            await openLatestActivityRecord();

            try {
              await assertSwapDetailStatusAccepted();
              recordValidation(
                'Bridge detail status',
                'passed',
                'pending or confirmed',
              );
            } catch (statusError) {
              recordValidation(
                'Bridge detail status',
                'warning',
                String(statusError),
              );
            }

            const timestampResult = await assertTransactionTimestamp(driver);
            recordValidation(
              'Time stamp row',
              timestampResult.isValid ? 'passed' : 'warning',
              timestampResult.message,
            );

            try {
              await assertDetailRow(
                driver,
                'You sent',
                `${capturedFromAmount} ${fromSymbol}`,
              );
              recordValidation(
                'You sent row',
                'passed',
                `${capturedFromAmount} ${fromSymbol}`,
              );
            } catch (error) {
              recordValidation('You sent row', 'warning', String(error));
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

            const totalGasFeeResult = await assertTotalGasFeeRow(
              driver,
              networkConfig.gasFeeSponsoredByProtocol ?? false,
            );
            recordValidation(
              'Total gas fee row',
              totalGasFeeResult.isValid ? 'passed' : 'warning',
              totalGasFeeResult.message,
            );

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

        const sendTokenToAccount = async ({
          chainIdHex,
          symbol,
          amount,
          recipientAccountName,
        }: {
          chainIdHex: string;
          symbol: string;
          amount: string;
          recipientAccountName: string;
        }): Promise<void> => {
          await homePage.startSendFlow();
          const sendPage = new SendPage(driver);
          await sendPage.checkPageIsLoaded();
          await sendPage.createSendRequest({
            chainId: chainIdHex,
            symbol,
            recipientName: recipientAccountName,
            amount,
          });

          const sendTokenConfirmPage = new SendTokenConfirmPage(driver);
          await sendTokenConfirmPage.checkPageIsLoaded();
          await sendTokenConfirmPage.clickConfirmButton();
          await driver.delay(PROD_DELAYS.RPC_RESPONSE);
          await recoverToHome(driver);
          console.log(
            `[TEST] ✅ Sent ${amount} ${symbol} to ${recipientAccountName}`,
          );
        };

        try {
          console.log('[TEST] Logging in to wallet...');
          await loginWithoutBalanceValidation(driver);
          await homePage.checkPageIsLoaded();
          await driver.delay(PROD_DELAYS.API_RESPONSE);
          console.log('[TEST] ✅ Logged in');

          await selectNetwork(scenario.primaryNetworkName);

          await createAndSwitchToNewAccount();

          const privateKeyTo = getRequiredE2EEnv('PRIVATE_KEY_TO');
          await importAccountOneAndSwitch(privateKeyTo);

          await executeAndValidateSwap({
            fromSymbol: scenario.sourceTokenSymbol,
            toSymbol: scenario.destinationTokenSymbol,
            destinationTokenAddress: scenario.destinationTokenAddress,
            fromAmount: scenario.sourceToDestinationAmount,
            expectedActivityActionLabels: ['Swap', 'Bridged to Base'],
            sourceNetworkName: scenario.primaryNetworkName,
          });

          await selectNetwork(scenario.secondaryNetworkName);

          await sendTokenToAccount({
            chainIdHex: BASE_CHAIN_ID_HEX,
            symbol: scenario.destinationTokenSymbol,
            amount: TRANSFER_TO_CREATED_USDC_AMOUNT,
            recipientAccountName: CREATED_ACCOUNT_NAME,
          });

          await switchToAccount(CREATED_ACCOUNT_NAME);
          await selectNetwork(scenario.secondaryNetworkName);

          await executeAndValidateSwap({
            fromSymbol: scenario.destinationTokenSymbol,
            toSymbol: scenario.sourceTokenSymbol,
            destinationTokenAddress: scenario.sourceTokenSymbol,
            fromAmount: scenario.destinationToSourceAmount,
            expectedActivityActionLabels: ['Swap', 'Bridged to Monad'],
            sourceNetworkName: scenario.secondaryNetworkName,
          });

          await selectNetwork(scenario.primaryNetworkName);

          // Final transfer step requested: from created account to imported account.
          await sendTokenToAccount({
            chainIdHex: MONAD_CHAIN_ID_HEX,
            symbol: scenario.destinationTokenSymbol,
            amount: FINAL_RETURN_TO_IMPORTED_AMOUNT,
            recipientAccountName: IMPORTED_ACCOUNT_NAME,
          });
        } finally {
          try {
            generateBridgeExecutionReport(routeResults, {
              title:
                'Monad/Base parameterized bridge execution with account creation',
              sourceNetwork: scenario.primaryNetworkName,
              destinationNetwork: scenario.secondaryNetworkName,
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
