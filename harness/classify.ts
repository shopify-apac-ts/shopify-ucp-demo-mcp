import type { CatalogProductDetailsSummary, CatalogSearchSummary } from '../src/catalog.js';
import type { CheckoutDiscoveryDiagnostic } from '../src/checkout.js';
import type { HarnessCase, HarnessIssueCode } from './types.js';

export function classifyHarnessResult(input: {
  testCase: HarnessCase;
  searchSummary?: CatalogSearchSummary;
  detailSummary?: CatalogProductDetailsSummary;
  discoveryDiagnostics?: CheckoutDiscoveryDiagnostic[];
  errorStage?: 'catalog' | 'product_details' | 'discovery';
  failedAssertions?: number;
}): HarnessIssueCode[] {
  const codes = new Set<HarnessIssueCode>();

  if (input.errorStage === 'catalog') codes.add('catalog_error');
  if (input.errorStage === 'product_details') codes.add('product_details_error');
  if (input.errorStage === 'discovery') codes.add('discovery_error');

  const summary = input.searchSummary;
  if (summary) {
    const expectations = input.testCase.expectations;
    if (
      (expectations?.requireGlobalCatalogExtension &&
        summary.globalCatalogExtension.versions.length === 0) ||
      (expectations?.minProductsWithExtensionMetadata !== undefined &&
        summary.globalCatalogExtension.productsWithMetadata <
          expectations.minProductsWithExtensionMetadata) ||
      (expectations?.minVariantsWithExtensionData !== undefined &&
        summary.globalCatalogExtension.variantsWithExtensionData <
          expectations.minVariantsWithExtensionData)
    ) {
      codes.add('catalog_extension_missing');
    }
    if (summary.responseShape === 'unknown') {
      codes.add('response_shape_changed');
    }
    if (summary.totalOffers === 0) {
      codes.add('catalog_no_match');
      const search = input.testCase.search;
      if (search?.ships_to || search?.ships_from || search?.available_for_sale) {
        codes.add('shipping_filter_too_strict');
      }
      if ((search?.context ?? '').length < 80) {
        codes.add('query_too_weak');
      }
    }
    if (
      summary.totalOffers > 0 &&
      summary.offersWithProducts === 0 &&
      summary.offersWithVariants === 0
    ) {
      codes.add('response_shape_changed');
    }
  }

  if (input.detailSummary) {
    if (
      input.detailSummary.offerCount > 0 &&
      !input.detailSummary.usesProductsSchema &&
      !input.detailSummary.usesVariantsSchema
    ) {
      codes.add('response_shape_changed');
    }
    if (input.detailSummary.offerCount === 0 && input.testCase.search?.ships_to) {
      codes.add('shipping_filter_too_strict');
    }
  }

  for (const diagnostic of input.discoveryDiagnostics ?? []) {
    if (diagnostic.status === 'manifest_missing') {
      codes.add('merchant_manifest_missing');
      codes.add('checkout_ucp_unsupported');
    } else if (diagnostic.status === 'shopping_service_missing') {
      codes.add('checkout_ucp_unsupported');
    } else if (
      diagnostic.status === 'network_fallback' ||
      diagnostic.status === 'http_fallback' ||
      diagnostic.status === 'manifest_malformed'
    ) {
      codes.add('checkout_endpoint_resolution_failed');
    }
  }

  if ((input.failedAssertions ?? 0) > 0) {
    codes.add('expectation_failed');
  }

  return [...codes].sort();
}
