import type {
  CatalogProductDetailsSummary,
  CatalogSearchSummary,
  SearchProductsParams,
} from '../src/catalog.js';
import type { CheckoutDiscoveryDiagnostic } from '../src/checkout.js';

export type HarnessStatus = 'pass' | 'fail' | 'error';

export type HarnessIssueCode =
  | 'catalog_no_match'
  | 'query_too_weak'
  | 'shipping_filter_too_strict'
  | 'response_shape_changed'
  | 'catalog_extension_missing'
  | 'merchant_manifest_missing'
  | 'checkout_ucp_unsupported'
  | 'checkout_endpoint_resolution_failed'
  | 'expectation_failed'
  | 'catalog_error'
  | 'product_details_error'
  | 'discovery_error';

export interface HarnessCase {
  name: string;
  description?: string;
  search?: SearchProductsParams;
  expectations?: {
    minOffers?: number;
    minCheckoutUrls?: number;
    expectedMerchantHosts?: string[];
    expectedTitleTerms?: string[];
    requireProductsOrVariants?: boolean;
    requireGlobalCatalogExtension?: boolean;
    minProductsWithExtensionMetadata?: number;
    minVariantsWithExtensionData?: number;
    requireProductDetails?: boolean;
    minProductDetailOffers?: number;
    requireDiscovery?: boolean;
    allowUcpUnsupported?: boolean;
  };
  discovery?: {
    merchantHosts?: string[];
    fromSearchResults?: boolean;
    maxMerchants?: number;
  };
}

export interface HarnessAssertion {
  ok: boolean;
  message: string;
}

export interface HarnessCaseResult {
  caseName: string;
  status: HarnessStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  searchArgs?: Record<string, unknown>;
  searchSummary?: CatalogSearchSummary;
  detailSummary?: CatalogProductDetailsSummary;
  discoveryDiagnostics: CheckoutDiscoveryDiagnostic[];
  assertions: HarnessAssertion[];
  issueCodes: HarnessIssueCode[];
  error?: string;
}

export interface HarnessRunResult {
  generatedAt: string;
  durationMs: number;
  totals: {
    cases: number;
    passed: number;
    failed: number;
    errored: number;
  };
  results: HarnessCaseResult[];
}
