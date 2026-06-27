/**
 * Network configuration for bridge execution tests
 *
 * Defines which networks support bridge testing and tokens to import.
 * Bridge operations are cross-chain transfers (e.g., Monad → Base).
 */

/**
 * Network configuration for bridge tests
 */
export type NetworkBridgeConfig = {
  /** Unique identifier for the network */
  networkId: string;
  /** Display name of the network */
  networkName: string;
  /** Chain ID (decimal number) */
  chainId: number;
  /** Native token symbol (e.g., MON, ETH) */
  nativeTokenSymbol: string;
  /**
   * Manually specified tokens to import.
   * Used when exact contract addresses are required.
   */
  manualTokens?: ManualToken[];
  /** Fixture setup method name from FixtureBuilder */
  fixtureSetupMethod: string;
  /** Optional: Block explorer URL */
  blockExplorerUrl?: string;
  /** Optional: ERC-20 token symbols to resolve for bridge execution tests */
  bridgeExecutionTokenSymbols?: string[];
  /** Optional: Ordered bridge routes for execution tests */
  bridgeExecutionRoutes?: BridgeExecutionRoute[];
  /**
   * Default source amount for routes that do not define `amount`.
   * Prefer route-level `amount` in `bridgeExecutionRoutes` for precise control.
   */
  defaultBridgeAmount?: number;
  /**
   * When true, this is a custom network requiring manual RPC setup during test.
   * Defaults to false.
   */
  requiresManualSetup?: boolean;
};

/**
 * A manually specified token for import — used when exact contract addresses are required.
 */
export type ManualToken = {
  /** Token symbol as it appears in MetaMask (e.g. 'USDC') */
  symbol: string;
  /** ERC-20 contract address on the network */
  address: string;
  /** Optional display name; defaults to symbol when omitted */
  name?: string;
  /** Token decimal precision; defaults to 18 when omitted */
  decimals?: number;
};

/**
 * Ordered bridge route definition for execution tests.
 * Bridge routes are cross-chain transfers (fromChain → toChain).
 */
export type BridgeExecutionRoute = {
  /** Source chain name (e.g., 'Monad') */
  fromChain: string;
  /** Source chain ID for network switching */
  fromChainId: number;
  /** Source token symbol (e.g., 'MON', 'AZND') */
  fromToken: string;
  /** Destination chain name (e.g., 'Base') */
  toChain: string;
  /** Destination chain ID for network switching and verification */
  toChainId: number;
  /** Destination token symbol (e.g., 'ETH', 'USDC') */
  toToken: string;
  /**
   * Source amount to enter for this route.
   * Ignored when `useMax` is true.
   */
  amount?: string | number;
  /**
   * When true, click Max instead of filling amount input.
   */
  useMax?: boolean;
  /**
   * When true, skip this route during test execution.
   * Defaults to false (route is enabled).
   */
  disableRoute?: boolean;
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
 * Result of a single bridge execution route
 */
export type BridgeRouteResult = {
  /** Route label e.g. "MON(Monad) → ETH(Base)" */
  route: string;
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  /** Destination chain ID (used for network switching) */
  toChainId: number;
  /** Source amount captured from the bridge UI before submission */
  fromAmount: string;
  /** Destination amount captured from the bridge UI before submission */
  toAmount: string;
  /** Per-check validation results captured while executing this route */
  validations?: BridgeValidationResult[];
  status: 'passed' | 'warning' | 'failed' | 'skipped';
  error?: string;
};

/**
 * Result of an individual validation check within a bridge route.
 */
export type BridgeValidationResult = {
  /** Human-readable validation name */
  name: string;
  /** Whether the validation passed, failed, or only warned */
  status: 'passed' | 'failed' | 'warning';
  /** Optional diagnostic details (actual value, warning text, etc.) */
  details?: string;
};

/**
 * Consolidated report for a bridge execution test run
 */
export type BridgeExecutionReport = {
  networkConfig: NetworkBridgeConfig;
  timestamp: string;
  totalRoutes: number;
  passedRoutes: number;
  warningRoutes: number;
  failedRoutes: number;
  routeResults: BridgeRouteResult[];
};

/**
 * Default from amount for bridge tests
 */
export const DEFAULT_BRIDGE_AMOUNT = 0.001;

/**
 * Bridge execution delay (longer than swaps due to cross-chain confirmation)
 */
export const BRIDGE_CONFIRMATION_TIMEOUT = 120000; // 2 minutes

/**
 * Network configurations for bridge execution tests
 * All routes span both Monad and Base networks for cross-chain testing.
 */
export const BRIDGE_TEST_NETWORKS: NetworkBridgeConfig[] = [
  {
    networkId: 'Monad',
    networkName: 'Monad',
    chainId: 143,
    nativeTokenSymbol: 'MON',
    manualTokens: [
      {
        symbol: 'AZND',
        name: 'Azimuth',
        address: '0x4917a5ec9fcb5e10f47cbb197abe6ab63be81fe8',
        decimals: 18,
      },
    ],
    fixtureSetupMethod: 'withNetworkControllerOnMonad',
    blockExplorerUrl: 'https://explorer.monad.xyz',
    bridgeExecutionTokenSymbols: ['AZND'],
    bridgeExecutionRoutes: [
      // To skip a route during test execution, add: disableRoute: true
      // Example: { fromChain: 'Monad', ..., disableRoute: true }
      // Skipped routes will appear in the report with 'skipped' status.
      // {
      //   fromChain: 'Sei',
      //   fromChainId: 1329,
      //   fromToken: 'SEI',
      //   toChain: 'Polygon',
      //   toChainId: 137,
      //   toToken: 'POL',
      //   amount: '10',
      // },
      // {
      //   fromChain: 'Polygon',
      //   fromChainId: 137,
      //   fromToken: 'POL',
      //   toChain: 'Sei',
      //   toChainId: 1329,
      //   toToken: 'SEI',
      //   amount: '6.5',
      // },
      {
        fromChain: 'Monad',
        fromChainId: 143,
        fromToken: 'MON',
        toChain: 'Base',
        toChainId: 8453,
        toToken: 'USDC',
        amount: '5',
      },
      // {
      //   fromChain: 'Base',
      //   fromChainId: 8453,
      //   fromToken: 'USDC',
      //   toChain: 'Monad',
      //   toChainId: 143,
      //   toToken: 'MON',
      //   amount: '0.0893',
      // },
      // {
      //   fromChain: 'Monad',
      //   fromChainId: 143,
      //   fromToken: 'MON',
      //   toChain: 'Base',
      //   toChainId: 8453,
      //   toToken: 'ETH',
      //   amount: '0.001',
      // },
      // {
      //   fromChain: 'Base',
      //   fromChainId: 8453,
      //   fromToken: 'ETH',
      //   toChain: 'Monad',
      //   toChainId: 143,
      //   toToken: 'AZND',
      //   amount: '0.0001',
      //   disableRoute: true
      // },
      // {
      //   fromChain: 'Monad',
      //   fromChainId: 143,
      //   fromToken: 'AZND',
      //   toChain: 'Base',
      //   toChainId: 8453,
      //   toToken: 'USDC',
      //   amount: '10',
      // },
      // {
      //   fromChain: 'Base',
      //   fromChainId: 8453,
      //   fromToken: 'USDC',
      //   toChain: 'Monad',
      //   toChainId: 143,
      //   toToken: 'MON',
      //   amount: '10',
      //   useMax: true,
      // },
    ],
    defaultBridgeAmount: 0.001,
  },
  {
    networkId: 'Base',
    networkName: 'Base',
    chainId: 8453,
    nativeTokenSymbol: 'ETH',
    manualTokens: [
      {
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
      },
    ],
    fixtureSetupMethod: 'withNetworkControllerOnBase',
    blockExplorerUrl: 'https://basescan.org',
    bridgeExecutionTokenSymbols: ['USDC'],
    defaultBridgeAmount: 0.001,
  },
];

/**
 * Helper: Find a network config by chain ID
 *
 * @param chainId - Chain ID to search for
 * @returns Network config or undefined if not found
 */
export function findNetworkByChainId(
  chainId: number,
): NetworkBridgeConfig | undefined {
  return BRIDGE_TEST_NETWORKS.find((config) => config.chainId === chainId);
}

/**
 * Helper: Find a network config by name
 *
 * @param networkName - Network name to search for
 * @returns Network config or undefined if not found
 */
export function findNetworkByName(
  networkName: string,
): NetworkBridgeConfig | undefined {
  return BRIDGE_TEST_NETWORKS.find(
    (config) =>
      config.networkName.toLowerCase() === networkName.toLowerCase(),
  );
}
