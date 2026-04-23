/**
 * Network configuration for swap quotation tests
 *
 * Defines which networks support swap testing and tokens to import
 */

/**
 * Network configuration for swap tests
 */
export type NetworkSwapConfig = {
  /** Unique identifier for the network */
  networkId: string;
  /** Display name of the network */
  networkName: string;
  /** Chain ID (decimal number) */
  chainId: number;
  /** Native token symbol (e.g., MON, ETH) */
  nativeTokenSymbol: string;
  /** URL to the tokenlist JSON file */
  tokenlistUrl: string;
  /** Optional: Fixture setup method name from FixtureBuilder */
  fixtureSetupMethod?: string;
  /** Optional: Block explorer URL */
  blockExplorerUrl?: string;
  /** Optional: ERC-20 token symbols to resolve from tokenlist for execution tests */
  swapExecutionTokenSymbols?: string[];
  /** Optional: Ordered swap routes for execution tests */
  swapExecutionRoutes?: { from: string; to: string }[];
  /**
   * When true, the "Total gas fee" row on the swap detail page is expected to
   * show "Paid by MetaMask" (green badge). Set for networks where MetaMask
   * sponsors gas (e.g. Monad, SEI). Defaults to false.
   */
  gasFeeSponsoredByProtocol?: boolean;
};

/**
 * Parameterized bridge route used by cross-chain execution specs.
 */
export type BridgeExecutionRouteConfig = {
  /** Route label e.g. "MON -> USDC (Monad -> Base)" */
  label: string;
  /** Network selected before starting the route */
  sourceNetworkName: string;
  /** Expected destination network in bridge details */
  destinationNetworkName: string;
  /** Source token symbol */
  fromSymbol: string;
  /** Destination token symbol */
  toSymbol: string;
  /** Input amount entered into the bridge form */
  fromAmount: string;
  /** Token selector input for the bridge destination */
  destinationTokenAddress: string;
  /** Accepted activity labels shown for this route */
  expectedActivityActionLabels: string[];
  /** Accepted bridge detail statuses */
  acceptedDetailStatuses?: string[];
  /** Route must fail instead of auto-reducing when funds are insufficient */
  hardFailOnInsufficientFunds?: boolean;
};

/**
 * Parameterized bridge scenario configuration.
 */
export type BridgeExecutionConfig = {
  /** Unique scenario identifier */
  scenarioId: string;
  /** Test title used by bridge execution specs */
  title: string;
  /** Network used when the bridge scenario starts */
  initialNetworkName: string;
  /** Known destination token contract on the bridge route */
  baseUsdcAddress: string;
  /** Convenience symbol values used by the bridge spec */
  monadNetworkName: string;
  monSymbol: string;
  usdcSymbol: string;
  monToUsdcAmount: string;
  usdcToMonAmount: string;
  /** Ordered routes executed by the bridge spec */
  routes: BridgeExecutionRouteConfig[];
};

/**
 * Token object structure (matching standard tokenlist format)
 */
export type Token = {
  chainId: number | string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  logoUri?: string;
};

/**
 * Swap quotation snapshot (values captured before/after token switch)
 */
export type QuotationSnapshot = {
  fromAmount: string;
  toAmount: string;
  networkFeeSponsored: string;
  slippageValue: string;
  priceImpact: string;
  minimumReceived: string;
  capturedAt: string;
};

/**
 * Token pair quotations for comparison
 */
export type TokenPairQuotations = {
  sourceToken: Token;
  destinationToken: Token;
  beforeSwitch: QuotationSnapshot;
  afterSwitch: QuotationSnapshot;
  assertion: {
    expectedTokensSwitch: boolean;
    valuesChanged: boolean;
  };
};

/**
 * Result of a single token-pair test
 */
export type QuotationTestResult = {
  networkName: string;
  tokenPair: string;
  sourceTokenSymbol: string;
  destinationTokenSymbol: string;
  quotations: TokenPairQuotations;
  status: 'passed' | 'failed';
  error?: string;
};

/**
 * Result of a single swap execution route
 */
export type SwapRouteResult = {
  /** Route label e.g. "MON → AUSD" */
  route: string;
  fromSymbol: string;
  toSymbol: string;
  /** Source amount captured from the swap UI before submission */
  fromAmount: string;
  /** Destination amount captured from the swap UI before submission */
  toAmount: string;
  /** Per-check validation results captured while executing this route */
  validations?: SwapValidationResult[];
  status: 'passed' | 'warning' | 'failed';
  error?: string;
};

/**
 * Result of an individual validation check within a swap route.
 */
export type SwapValidationResult = {
  /** Human-readable validation name */
  name: string;
  /** Whether the validation passed, failed, or only warned */
  status: 'passed' | 'failed' | 'warning';
  /** Optional diagnostic details (actual value, warning text, etc.) */
  details?: string;
};

/**
 * Consolidated report for a swap execution test run
 */
export type SwapExecutionReport = {
  networkName: string;
  chainId: number;
  timestamp: string;
  totalRoutes: number;
  passedRoutes: number;
  warningRoutes: number;
  failedRoutes: number;
  routeResults: SwapRouteResult[];
};

/**
 * Consolidated test results for report generation
 */
export type ConsolidatedTestResults = {
  networkName: string;
  chainId: number;
  tokenlistUrl: string;
  nativeTokenSymbol: string;
  timestamp: string;
  tokensImported: number;
  totalTestCases: number;
  passedTestCases: number;
  failedTestCases: number;
  testResults: QuotationTestResult[];
};

/**
 * Number of tokens to import from tokenlist
 */
export const TOKENS_TO_IMPORT = 3;

/**
 * Default from amount for swap tests
 */
export const DEFAULT_SWAP_AMOUNT = 20;

/**
 * Network configurations for swap quotation tests
 * Add new networks here to support them in tests
 */
export const SWAP_TEST_NETWORKS: NetworkSwapConfig[] = [
  {
    networkId: 'Mon',
    networkName: 'Monad',
    chainId: 143,
    nativeTokenSymbol: 'MON',
    tokenlistUrl:
      'https://raw.githubusercontent.com/monad-crypto/token-list/refs/heads/main/tokenlist-mainnet.json',
    fixtureSetupMethod: 'withNetworkControllerOnMonad',
    blockExplorerUrl: 'https://explorer.monad.xyz',
    swapExecutionTokenSymbols: ['AUSD', 'AZND'],
    // swapExecutionTokenSymbols: ['AUSD', 'AZND', 'BTC.b'],
    swapExecutionRoutes: [
      { from: 'MON', to: 'AUSD' },
      { from: 'AUSD', to: 'AZND' },
      // { from: 'AZND', to: 'BTC.b' },
      { from: 'AZND', to: 'MON' },
    ],
    gasFeeSponsoredByProtocol: true,
  },
  // Add more networks here as needed
  // Example for future network:
  // {
  //   networkId: 'Base',
  //   networkName: 'Base',
  //   chainId: 8453,
  //   nativeTokenSymbol: 'ETH',
  //   tokenlistUrl: 'https://example.com/tokenlist.json',
  //   fixtureSetupMethod: 'withNetworkControllerOnBase',
  // },
];

/**
 * Shared bridge execution configuration used by dedicated cross-chain specs.
 */
export const BRIDGE_TEST_CONFIGS: BridgeExecutionConfig[] = [
  {
    scenarioId: 'monad-base-usdc',
    title: 'Monad MON <-> Base USDC Bridge Execution',
    initialNetworkName: 'Monad',
    baseUsdcAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    monadNetworkName: 'Monad',
    monSymbol: 'MON',
    usdcSymbol: 'USDC',
    monToUsdcAmount: '20',
    usdcToMonAmount: '0.5',
    routes: [
      {
        label: 'MON -> USDC (Monad -> Base)',
        sourceNetworkName: 'Monad',
        destinationNetworkName: 'Base',
        fromSymbol: 'MON',
        toSymbol: 'USDC',
        fromAmount: '20',
        destinationTokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        expectedActivityActionLabels: ['Swap', 'Bridged to Base'],
        acceptedDetailStatuses: ['pending', 'confirmed'],
      },
      {
        label: 'USDC -> MON (Base -> Monad)',
        sourceNetworkName: 'Base',
        destinationNetworkName: 'Monad',
        fromSymbol: 'USDC',
        toSymbol: 'MON',
        fromAmount: '0.5',
        destinationTokenAddress: 'MON',
        expectedActivityActionLabels: ['Swap', 'Bridged to Monad'],
        acceptedDetailStatuses: ['pending', 'confirmed'],
        hardFailOnInsufficientFunds: true,
      },
    ],
  },
];

/**
 * Get network config by network ID
 * @param networkId - The unique identifier for the network
 * @returns The network configuration or undefined if not found
 */
export function getNetworkSwapConfig(
  networkId: string,
): NetworkSwapConfig | undefined {
  return SWAP_TEST_NETWORKS.find((config) => config.networkId === networkId);
}

/**
 * Get bridge execution config by scenario ID.
 *
 * @param scenarioId - The unique identifier for the bridge scenario.
 * @returns The bridge execution configuration or undefined if not found.
 */
export function getBridgeExecutionConfig(
  scenarioId: string,
): BridgeExecutionConfig | undefined {
  return BRIDGE_TEST_CONFIGS.find((config) => config.scenarioId === scenarioId);
}

/**
 * Get all network IDs for swap tests
 * @returns Array of all network IDs that support swap testing
 */
export function getAllSwapTestNetworkIds(): string[] {
  return SWAP_TEST_NETWORKS.map((config) => config.networkId);
}

/**
 * Validate that a network config has all required fields for swap testing
 * @param config - The network configuration to validate
 * @throws Error if validation fails
 */
export function validateNetworkSwapConfig(config: NetworkSwapConfig): void {
  if (!config.networkId) {
    throw new Error('Network config missing required field: networkId');
  }
  if (!config.networkName) {
    throw new Error('Network config missing required field: networkName');
  }
  if (typeof config.chainId !== 'number') {
    throw new Error('Network config missing required field: chainId');
  }
  if (!config.nativeTokenSymbol) {
    throw new Error('Network config missing required field: nativeTokenSymbol');
  }
  if (!config.tokenlistUrl) {
    throw new Error('Network config missing required field: tokenlistUrl');
  }
}
