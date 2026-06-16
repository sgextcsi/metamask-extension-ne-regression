/**
 * Production E2E Test: Cross-Chain Bridge Execution
 *
 * Submits live bridge transactions across a predefined sequence of routes,
 * verifies each route results in a confirmed activity entry on the destination
 * chain, asserts the detail-page values, and generates a simple markdown
 * execution report.
 *
 * Routes tested (Monad ↔ Base):
 * 1. MON(Monad) → ETH(Base) -- Native to Native
 * 2. ETH(Base) → AZND(Monad) -- Native to ERC-20
 * 3. AZND(Monad) → USDC(Base) -- ERC-20 to ERC-20
 * 4. USDC(Base) → MON(Monad) -- ERC-20 to Native
 *
 * Prerequisites:
 * - PRIVATE_KEY_FROM in .env.e2e (funded account with balance on source chains)
 * - Real network connectivity to Monad and Base RPCs
 */

import { Suite } from 'mocha';
import FixtureBuilder from '../../../fixtures/fixture-builder';
import { withProductionFixtures } from '../../helpers/prod-with-fixtures';
import { PROD_DELAYS } from '../../helpers/prod-test-helpers';
import { loginWithoutBalanceValidation } from '../../../page-objects/flows/login.flow';
import HomePage from '../../../page-objects/pages/home/homepage';
import NetworkManager from '../../../page-objects/pages/network-manager';
import { Driver } from '../../../webdriver/driver';
import { getRequiredE2EEnv } from '../../../helpers/e2e-env';
import {
  BRIDGE_TEST_NETWORKS,
  DEFAULT_BRIDGE_AMOUNT,
  Token,
  BridgeRouteResult,
  BridgeValidationResult,
} from './network-bridge-config';
import {
  resolveBridgeTokensBySymbols,
  importSingleFundedAccountForBridge,
  enterBridgeFlow,
  fillBridgeRouteDetails,
  waitForBridgeQuoteReady,
  captureBridgeAmounts,
  submitBridgeAndWaitForConfirmed,
  assertBridgeActivityPrimaryCurrency,
  openLatestBridgeActivityRecord,
  assertBridgeDetailConfirmed,
  assertBridgeDetailRow,
  navigateBackToHomeForBridge,
  recoverToHomeForBridge,
  generateBridgeExecutionReport,
  switchToDestinationNetwork,
  verifyBridgeActivityOnDestination,
  prepareForNextRoute,
} from './bridge-execution-helpers';

function getCliOptionValue(optionName: string): string | undefined {
  const prefixedOption = `--${optionName}`;
  const exactIndex = process.argv.findIndex((arg) => arg === prefixedOption);
  if (exactIndex !== -1) {
    const nextArg = process.argv[exactIndex + 1];
    return nextArg && !nextArg.startsWith('--') ? nextArg : undefined;
  }

  const inlineOption = process.argv.find((arg) =>
    arg.startsWith(`${prefixedOption}=`),
  );
  return inlineOption ? inlineOption.slice(prefixedOption.length + 1) : undefined;
}

function parseNetworkNames(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

async function selectNetworkViaHomeSelector(
  driver: Driver,
  chainId: number,
): Promise<void> {
  const networksListButton = '[data-testid="sort-by-networks"]';
  const networkListItemSelector = `[data-testid="network-list-item-eip155:${chainId}"]`;

  const maxAttempts = 3;
  let lastError: unknown;

  // Start with a best-effort cleanup in case onboarding/help modals are open.
  await dismissBlockingOverlays(driver);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await driver.clickElement(networksListButton);
      await driver.waitForSelector('[role="dialog"]');
      await driver.clickElement(networkListItemSelector);
      await driver.delay(PROD_DELAYS.API_RESPONSE);
      return;
    } catch (error) {
      lastError = error;
      const errorMessage = String(error);
      const isInterceptionError =
        errorMessage.includes('ElementClickInterceptedError') ||
        errorMessage.includes('element click intercepted') ||
        errorMessage.includes('Other element would receive the click');

      if (!isInterceptionError || attempt === maxAttempts) {
        throw error;
      }

      console.log(
        `[BRIDGE] Network selector click intercepted (attempt ${attempt}/${maxAttempts}). Closing overlay and retrying...`,
      );
      await dismissBlockingOverlays(driver);
      await driver.delay(1000);
    }
  }

  throw lastError;
}

async function dismissBlockingOverlays(driver: Driver): Promise<void> {
  const closeButtonSelectors = [
    '[data-testid="import-tokens-modal-close-button"]',
    '.mm-modal-content__header-close-button',
    'button[aria-label="Close"]',
    '[data-testid="popover-close"]',
  ];

  for (const selector of closeButtonSelectors) {
    try {
      const isVisible = await driver.isElementPresentAndVisible(selector, 500);
      if (isVisible) {
        await driver.clickElement(selector);
        await driver.delay(500);
      }
    } catch (_error) {
      // Best-effort cleanup only.
    }
  }

  // Ensure we are back on a stable, clickable home context.
  try {
    await driver.clickElement('[data-testid="account-overview__asset-tab"]');
    await driver.delay(500);
  } catch (_error) {
    // If tab is already active or not clickable yet, proceed to retry.
  }
}

/**
 * Production E2E Test: Cross-Chain Bridge Execution
 *
 * Configuration is driven by BRIDGE_TEST_NETWORKS — only networks with
 * `bridgeExecutionRoutes` defined will run.
 */
describe('Production E2E: Cross-Chain Bridge Execution', function (this: Suite) {
  this.timeout(900000); // 15 minutes total for all routes

  // Accept networks from CLI (`--network Monad`, `--networks Monad,Base`) or
  // env vars (`NETWORK`, `NETWORKS`). If not provided, run all networks.
  const networksFromCli =
    getCliOptionValue('network') ??
    getCliOptionValue('networks') ??
    getCliOptionValue('networkNames');
  const selectedNetworkNames = parseNetworkNames(
    networksFromCli ?? process.env.NETWORK ?? process.env.NETWORKS,
  );
  const selectedNetworks = selectedNetworkNames.length
    ? BRIDGE_TEST_NETWORKS.filter((config) =>
        selectedNetworkNames.some(
          (name) =>
            config.networkName.toLowerCase() === name.toLowerCase() ||
            config.networkId.toLowerCase() === name.toLowerCase(),
        ),
      )
    : BRIDGE_TEST_NETWORKS;

  if (selectedNetworkNames.length > 0 && selectedNetworks.length === 0) {
    throw new Error(
      `No matching bridge network configurations found for: ${selectedNetworkNames.join(', ')}`,
    );
  }

  selectedNetworks.forEach((networkConfig) => {
    if (!networkConfig.bridgeExecutionRoutes?.length) {
      return; // skip networks not yet configured for execution tests
    }

    describe(`Network: ${networkConfig.networkName}`, function (this: Suite) {
      it(`should execute bridge routes for ${networkConfig.nativeTokenSymbol}`, async function () {
        // Collect per-route results for the final markdown report
        const routeResults: BridgeRouteResult[] = [];
        const fixtureBuilder = new FixtureBuilder();
        const setupMethod =
          fixtureBuilder[
            networkConfig.fixtureSetupMethod as keyof typeof fixtureBuilder
          ];

        if (typeof setupMethod !== 'function') {
          throw new Error(
            `Invalid fixture setup method: ${networkConfig.fixtureSetupMethod}`,
          );
        }

        await withProductionFixtures(
          {
            fixtures: (setupMethod as () => FixtureBuilder)
              .call(fixtureBuilder)
              .build(),
            title:
              this.test?.fullTitle() ||
              `Bridge execution test for ${networkConfig.networkName}`,
            extendedTimeoutMultiplier: 2,
          },
          async ({ driver }: { driver: Driver }) => {
            console.log(`\n${'='.repeat(80)}`);
            console.log(
              `[BRIDGE] Starting bridge execution test for ${networkConfig.networkName}`,
            );
            console.log(`${'='.repeat(80)}\n`);

            // ----------------------------------------------------------------
            // Step 1: Login
            // ----------------------------------------------------------------
            console.log(`[BRIDGE] Logging in to wallet...`);
            await loginWithoutBalanceValidation(driver);
            const homePage = new HomePage(driver);
            await homePage.checkPageIsLoaded();
            await driver.delay(PROD_DELAYS.API_RESPONSE);
            console.log(`[BRIDGE] ✅ Logged in`);

            // ----------------------------------------------------------------
            // Step 2: Select network
            // ----------------------------------------------------------------
            console.log(
              `[BRIDGE] Selecting ${networkConfig.networkName} network...`,
            );

            // Prefer the home network selector, and fall back to NetworkManager
            // for backwards compatibility when the selector entry is not present.
            try {
              await selectNetworkViaHomeSelector(driver, networkConfig.chainId);
            } catch (homeSelectorError) {
              console.log(
                `[BRIDGE] Home selector network switch failed, falling back to NetworkManager: ${String(homeSelectorError)}`,
              );

              await dismissBlockingOverlays(driver);
              const networkManager = new NetworkManager(driver);
              await networkManager.openNetworkManager();
              await networkManager.selectTab('Popular');
              await networkManager.selectNetworkByNameWithWait(
                networkConfig.networkName,
              );
            }

            await homePage.checkPageIsLoaded();
            await driver.delay(PROD_DELAYS.API_RESPONSE);
            console.log(
              `[BRIDGE] ✅ Network selected: ${networkConfig.networkName}`,
            );

            // ----------------------------------------------------------------
            // Step 3: Import funded account
            // PRIVATE_KEY_FROM holds the account that has balance for bridges.
            // This does NOT import the entire wallet — it adds one funded
            // account to the existing MetaMask instance.
            // ----------------------------------------------------------------
            console.log(
              `[BRIDGE] Importing funded account (PRIVATE_KEY_FROM)...`,
            );
            const privateKeyFrom = getRequiredE2EEnv('PRIVATE_KEY_FROM');
            await importSingleFundedAccountForBridge(driver, privateKeyFrom);
            console.log(`[BRIDGE] ✅ Funded account imported and active`);

            // ----------------------------------------------------------------
            // Step 4: Resolve ERC-20 tokens to import.
            // Manual tokens supply exact contract addresses directly.
            // ----------------------------------------------------------------
            let resolvedTokens: Token[];

            if (networkConfig.manualTokens?.length) {
              console.log(
                `[BRIDGE] Using manual token list for ${networkConfig.networkName}...`,
              );
              resolvedTokens = networkConfig.manualTokens.map((mt) => ({
                chainId: networkConfig.chainId,
                address: mt.address,
                name: mt.name ?? mt.symbol,
                symbol: mt.symbol,
                decimals: mt.decimals ?? 18,
              }));
            } else {
              console.log(
                `[BRIDGE] No manual tokens configured for ${networkConfig.networkName}`,
              );
              resolvedTokens = [];
            }

            if (resolvedTokens.length > 0) {
              console.log(
                `[BRIDGE] Resolved ${resolvedTokens.length} execution tokens: ${resolvedTokens.map((t) => t.symbol).join(', ')}`,
              );
            }

            // Build symbol → token lookup for address resolution
            const tokenBySymbol = new Map<string, Token>(
              resolvedTokens.map((t) => [t.symbol, t]),
            );

            // ----------------------------------------------------------------
            // Step 5: Execute each bridge route sequentially.
            // Amounts are route-configured (`route.amount`) unless `useMax`
            // is enabled for that route.
            // ----------------------------------------------------------------
            // bridgeExecutionRoutes is guaranteed non-empty (checked by the
            // outer guard: `if (!networkConfig.bridgeExecutionRoutes?.length)`)
            const executionRoutes = networkConfig.bridgeExecutionRoutes ?? [];

            for (const route of executionRoutes) {
              const {
                fromChain,
                fromChainId,
                fromToken: fromSymbol,
                toChain,
                toChainId,
                toToken: toSymbol,
                amount,
                useMax,
                disableRoute,
              } = route;
              const routeLabel = `${fromSymbol}(${fromChain}) → ${toSymbol}(${toChain})`;

              // Skip this route if disableRoute is true
              if (disableRoute) {
                console.log(
                  `[BRIDGE] ⏭️ Route skipped: ${routeLabel} (disableRoute: true)`,
                );
                routeResults.push({
                  route: routeLabel,
                  fromChain,
                  fromToken: fromSymbol,
                  toChain,
                  toToken: toSymbol,
                  toChainId,
                  fromAmount: '-',
                  toAmount: '-',
                  validations: [{ name: 'Route disabled', status: 'passed' }],
                  status: 'skipped',
                });
                continue;
              }

              const plannedFromAmount = String(
                amount ??
                  networkConfig.defaultBridgeAmount ??
                  DEFAULT_BRIDGE_AMOUNT,
              );
              const useMaxForRoute = Boolean(useMax);

              const routeResult: BridgeRouteResult = {
                route: routeLabel,
                fromChain,
                fromToken: fromSymbol,
                toChain,
                toToken: toSymbol,
                toChainId,
                fromAmount: '',
                toAmount: '',
                validations: [],
                status: 'failed',
              };

              const recordValidation = (
                name: string,
                status: BridgeValidationResult['status'],
                details?: string,
              ) => {
                routeResult.validations?.push({ name, status, details });
              };

              console.log(`\n[BRIDGE] ── Route: ${routeLabel} ──`);

              try {
                // -- Enter the bridge page fresh from home for every route --
                console.log(
                  `[BRIDGE] Entering bridge flow for route: ${routeLabel}`,
                );
                await enterBridgeFlow(
                  driver,
                  fromChain,
                  fromSymbol,
                  toChain,
                  toSymbol,
                );
                recordValidation('Bridge flow entered', 'passed');

                // -- Fill bridge route details --
                await fillBridgeRouteDetails(
                  driver,
                  fromSymbol,
                  plannedFromAmount,
                  toSymbol,
                  useMaxForRoute,
                  fromChainId,
                  toChainId,
                );
                recordValidation('Route details filled', 'passed');

                // -- Wait for quote and assert it's ready --
                await waitForBridgeQuoteReady(driver);
                recordValidation('Quote ready', 'passed');

                // -- Capture amounts before submission --
                const { fromAmount, toAmount } =
                  await captureBridgeAmounts(driver);
                routeResult.fromAmount = fromAmount;
                routeResult.toAmount = toAmount;
                recordValidation(
                  'Amounts captured',
                  'passed',
                  `${fromAmount} → ${toAmount}`,
                );

                // -- Submit and wait for confirmed activity entry --
                await submitBridgeAndWaitForConfirmed(
                  driver,
                  fromSymbol,
                  toSymbol,
                );
                recordValidation('Bridge submitted and confirmed', 'passed');

                // -- Switch to destination network for verification --
                await switchToDestinationNetwork(driver, toChainId);
                recordValidation('Switched to destination network', 'passed');

                // -- Verify bridge activity on destination network --
                await verifyBridgeActivityOnDestination(
                  driver,
                  fromSymbol,
                  toSymbol,
                  toAmount,
                );
                recordValidation(
                  'Bridge activity verified on destination',
                  'passed',
                );

                // -- Open detail page on destination --
                await openLatestBridgeActivityRecord(
                  driver,
                  fromSymbol,
                  toSymbol,
                );
                recordValidation('Activity detail page opened on destination', 'passed');

                // -- Assert detail page --
                await assertBridgeDetailConfirmed(driver);
                recordValidation('Detail status confirmed on destination', 'passed');

                // -- Assert detail rows on destination --
                if (useMaxForRoute) {
                  await assertBridgeDetailRow(driver, 'You sent', fromSymbol);
                } else {
                  await assertBridgeDetailRow(
                    driver,
                    'You sent',
                    `${fromAmount} ${fromSymbol}`,
                  );
                }
                recordValidation(
                  'Detail You sent row',
                  'passed',
                  useMaxForRoute
                    ? `contains ${fromSymbol} (max route)`
                    : `${fromAmount} ${fromSymbol}`,
                );

                await assertBridgeDetailRow(
                  driver,
                  'You received',
                  `${toAmount} ${toSymbol}`,
                );
                recordValidation(
                  'Detail You received row',
                  'passed',
                  `${toAmount} ${toSymbol}`,
                );

                // -- Prepare for next route (may need to switch networks) --
                const nextRouteIndex = executionRoutes.indexOf(route) + 1;
                const nextRoute = executionRoutes[nextRouteIndex];
                await prepareForNextRoute(driver, nextRoute, toChain);
                recordValidation('Prepared for next route', 'passed');

                routeResult.status = 'passed';
                console.log(`[BRIDGE] ✅ Route passed: ${routeLabel}`);
              } catch (error) {
                routeResult.status = 'failed';
                routeResult.error = String(error);
                recordValidation(
                  'Route execution error',
                  'failed',
                  String(error),
                );
                console.error(`[BRIDGE] ❌ Route failed: ${routeLabel}`);
                console.error(error);

                const recovered = await recoverToHomeForBridge(driver);
                if (!recovered) {
                  console.error(
                    `[BRIDGE] Recovery failed after route ${routeLabel} — stopping suite`,
                  );
                  routeResults.push(routeResult);
                  break;
                }
              }

              routeResults.push(routeResult);
            }

            // ----------------------------------------------------------------
            // Step 6: Generate markdown execution report
            // ----------------------------------------------------------------
            try {
              generateBridgeExecutionReport(routeResults, networkConfig);
            } catch (reportError) {
              console.warn(
                `[BRIDGE] ⚠️  Failed to generate report:`,
                reportError,
              );
            }

            // Fail the test if any routes did not pass
            const failedRoutes = routeResults.filter(
              (r) => r.status === 'failed',
            );
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
  });
});
