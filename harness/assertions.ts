import type { HarnessAssertion, HarnessCase } from './types.js';
import type {
  CatalogProductDetailsSummary,
  CatalogSearchSummary,
} from '../src/catalog.js';
import type { CheckoutDiscoveryDiagnostic } from '../src/checkout.js';

function includesAnyHost(actualHosts: string[], expectedHosts: string[]): boolean {
  return expectedHosts.some((expected) =>
    actualHosts.some((actual) => actual === expected || actual.endsWith(`.${expected}`))
  );
}

function includesAnyTerm(titles: string[], terms: string[]): boolean {
  const normalizedTitles = titles.map((title) => title.toLowerCase());
  return terms.some((term) =>
    normalizedTitles.some((title) => title.includes(term.toLowerCase()))
  );
}

export function assertHarnessCase(
  testCase: HarnessCase,
  searchSummary?: CatalogSearchSummary,
  detailSummary?: CatalogProductDetailsSummary,
  discoveryDiagnostics: CheckoutDiscoveryDiagnostic[] = [],
): HarnessAssertion[] {
  const expectations = testCase.expectations ?? {};
  const assertions: HarnessAssertion[] = [];

  if (expectations.minOffers !== undefined) {
    assertions.push({
      ok: (searchSummary?.totalOffers ?? 0) >= expectations.minOffers,
      message: `Catalog returned at least ${expectations.minOffers} offer(s)`,
    });
  }

  if (expectations.minCheckoutUrls !== undefined) {
    const checkoutUrlCount =
      searchSummary?.offersWithCheckoutUrl ?? detailSummary?.offersWithCheckoutUrl ?? 0;
    assertions.push({
      ok: checkoutUrlCount >= expectations.minCheckoutUrls,
      message: `At least ${expectations.minCheckoutUrls} offer(s) included checkout URLs`,
    });
  }

  if (expectations.expectedMerchantHosts?.length) {
    const hosts = [
      ...(searchSummary?.merchantHosts ?? []),
      ...(detailSummary?.merchantHosts ?? []),
      ...discoveryDiagnostics.map((diag) => diag.shopDomain),
    ];
    assertions.push({
      ok: includesAnyHost(hosts, expectations.expectedMerchantHosts),
      message: `At least one expected merchant appeared: ${expectations.expectedMerchantHosts.join(', ')}`,
    });
  }

  if (expectations.expectedTitleTerms?.length) {
    assertions.push({
      ok: includesAnyTerm(searchSummary?.productTitles ?? [], expectations.expectedTitleTerms),
      message: `At least one title contained: ${expectations.expectedTitleTerms.join(', ')}`,
    });
  }

  if (expectations.requireProductsOrVariants) {
    assertions.push({
      ok:
        searchSummary !== undefined &&
        (searchSummary.offersWithProducts > 0 || searchSummary.offersWithVariants > 0),
      message: 'Catalog response included products[] or variants[] child offers',
    });
  }

  if (expectations.requireGlobalCatalogExtension) {
    assertions.push({
      ok: (searchSummary?.globalCatalogExtension.versions.length ?? 0) > 0,
      message: 'Catalog advertised the dev.shopify.catalog.global extension',
    });
  }

  if (expectations.minProductsWithExtensionMetadata !== undefined) {
    assertions.push({
      ok:
        (searchSummary?.globalCatalogExtension.productsWithMetadata ?? 0) >=
        expectations.minProductsWithExtensionMetadata,
      message: `At least ${expectations.minProductsWithExtensionMetadata} product(s) included Shopify extension metadata`,
    });
  }

  if (expectations.minVariantsWithExtensionData !== undefined) {
    assertions.push({
      ok:
        (searchSummary?.globalCatalogExtension.variantsWithExtensionData ?? 0) >=
        expectations.minVariantsWithExtensionData,
      message: `At least ${expectations.minVariantsWithExtensionData} variant(s) included Shopify extension data`,
    });
  }

  if (expectations.requireProductDetails) {
    assertions.push({
      ok: Boolean(detailSummary),
      message: 'Product details call completed',
    });
  }

  if (expectations.minProductDetailOffers !== undefined) {
    assertions.push({
      ok: (detailSummary?.offerCount ?? 0) >= expectations.minProductDetailOffers,
      message: `Product details returned at least ${expectations.minProductDetailOffers} shop offer(s)`,
    });
  }

  if (expectations.requireDiscovery || testCase.discovery) {
    const supportedCount = discoveryDiagnostics.filter((diag) => diag.status === 'supported').length;
    const ok = expectations.allowUcpUnsupported
      ? discoveryDiagnostics.length > 0
      : supportedCount > 0;
    assertions.push({
      ok,
      message: expectations.allowUcpUnsupported
        ? 'Merchant discovery produced a supported endpoint or a classified fallback'
        : 'Merchant discovery found at least one UCP shopping endpoint',
    });
  }

  return assertions;
}
