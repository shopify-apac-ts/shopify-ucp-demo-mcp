import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessCaseResult, HarnessRunResult } from './types.js';

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function redactMerchantString(value: string | undefined): string | undefined {
  if (!value) return value;
  const extensionToken = '__SHOPIFY_GLOBAL_CATALOG_EXTENSION__';
  return value
    .replaceAll('dev.shopify.catalog.global', extensionToken)
    .replace(/https?:\/\/[^\s|)]+/g, 'https://[redacted-merchant]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '[redacted-merchant]')
    .replaceAll(extensionToken, 'dev.shopify.catalog.global');
}

function redactCaseResult(result: HarnessCaseResult): HarnessCaseResult {
  const merchantLabels = new Map<string, string>();
  const labelFor = (host: string): string => {
    const existing = merchantLabels.get(host);
    if (existing) return existing;
    const label = `merchant-${merchantLabels.size + 1}`;
    merchantLabels.set(host, label);
    return label;
  };

  return {
    ...result,
    searchSummary: result.searchSummary
      ? {
          ...result.searchSummary,
          merchantHosts: result.searchSummary.merchantHosts.map(labelFor),
        }
      : undefined,
    detailSummary: result.detailSummary
      ? {
          ...result.detailSummary,
          merchantHosts: result.detailSummary.merchantHosts.map(labelFor),
        }
      : undefined,
    discoveryDiagnostics: result.discoveryDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      shopDomain: labelFor(diagnostic.shopDomain),
      manifestUrl: `https://${labelFor(diagnostic.shopDomain)}/.well-known/ucp`,
      endpoint: redactMerchantString(diagnostic.endpoint),
      reason: redactMerchantString(diagnostic.reason),
    })),
    assertions: result.assertions.map((assertion) => ({
      ...assertion,
      message: redactMerchantString(assertion.message) ?? assertion.message,
    })),
    error: redactMerchantString(result.error),
  };
}

function redactRunResult(run: HarnessRunResult): HarnessRunResult {
  return {
    ...run,
    results: run.results.map(redactCaseResult),
  };
}

export function renderMarkdownReport(run: HarnessRunResult): string {
  const lines: string[] = [];
  lines.push('# UCP Demo Self-Test Report');
  lines.push('');
  lines.push(`Generated: ${run.generatedAt}`);
  lines.push(`Duration: ${run.durationMs}ms`);
  lines.push('');
  lines.push('| Cases | Passed | Failed | Errored |');
  lines.push('|---:|---:|---:|---:|');
  lines.push(
    `| ${run.totals.cases} | ${run.totals.passed} | ${run.totals.failed} | ${run.totals.errored} |`
  );
  lines.push('');

  for (const result of run.results) {
    lines.push(`## ${result.caseName}`);
    lines.push('');
    lines.push(`Status: **${result.status}**`);
    lines.push(`Duration: ${result.durationMs}ms`);
    lines.push(`Issue codes: ${formatList(result.issueCodes)}`);
    if (result.error) lines.push(`Error: \`${result.error}\``);
    lines.push('');

    if (result.searchSummary) {
      const s = result.searchSummary;
      lines.push('### Catalog Search');
      lines.push('');
      lines.push(`- Offers: ${s.totalOffers}`);
      lines.push(`- Offers with products[]: ${s.offersWithProducts}`);
      lines.push(`- Offers with variants[]: ${s.offersWithVariants}`);
      lines.push(`- Offers with checkoutUrl: ${s.offersWithCheckoutUrl}`);
      lines.push(`- Response shape: ${s.responseShape}`);
      lines.push(`- Merchant hosts: ${formatList(s.merchantHosts)}`);
      lines.push(`- Currencies: ${formatList(s.currencies)}`);
      lines.push(`- Global Catalog extension versions: ${formatList(s.globalCatalogExtension.versions)}`);
      lines.push(`- Products with extension metadata: ${s.globalCatalogExtension.productsWithMetadata}`);
      lines.push(`- Variants with extension data: ${s.globalCatalogExtension.variantsWithExtensionData}/${s.globalCatalogExtension.totalVariants}`);
      lines.push(`- Variants with native checkout eligibility: ${s.globalCatalogExtension.variantsWithNativeCheckoutEligibility}`);
      lines.push(`- Variants with running-low signal: ${s.globalCatalogExtension.variantsWithRunningLowSignal}`);
      lines.push(`- Variants with purchase requirements: ${s.globalCatalogExtension.variantsWithRequirements}`);
      lines.push('');
    }

    if (result.detailSummary) {
      const d = result.detailSummary;
      lines.push('### Product Details');
      lines.push('');
      lines.push(`- Product title: ${d.productTitle ?? 'unknown'}`);
      lines.push(`- Shop offers: ${d.offerCount}`);
      lines.push(`- Uses products[] schema: ${d.usesProductsSchema}`);
      lines.push(`- Uses variants[] schema: ${d.usesVariantsSchema}`);
      lines.push(`- Offers with checkoutUrl: ${d.offersWithCheckoutUrl}`);
      lines.push('');
    }

    if (result.discoveryDiagnostics.length > 0) {
      lines.push('### Merchant Discovery');
      lines.push('');
      lines.push('| Merchant | Status | Endpoint / reason |');
      lines.push('|---|---|---|');
      for (const diagnostic of result.discoveryDiagnostics) {
        lines.push(
          `| ${diagnostic.shopDomain} | ${diagnostic.status} | ${
            diagnostic.endpoint ?? diagnostic.reason ?? ''
          } |`
        );
      }
      lines.push('');
    }

    if (result.assertions.length > 0) {
      lines.push('### Assertions');
      lines.push('');
      for (const assertion of result.assertions) {
        lines.push(`- ${assertion.ok ? 'PASS' : 'FAIL'}: ${assertion.message}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeReports(
  run: HarnessRunResult,
  reportDir: string,
  options: { includeMerchantDetails?: boolean } = {},
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(reportDir, { recursive: true });
  const reportRun = options.includeMerchantDetails ? run : redactRunResult(run);
  const stamp = sanitizeFilePart(run.generatedAt.replace(/[:.]/g, '-'));
  const jsonPath = join(reportDir, `ucp-demo-self-test-${stamp}.json`);
  const markdownPath = join(reportDir, `ucp-demo-self-test-${stamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(reportRun, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdownReport(reportRun), 'utf8');

  return { jsonPath, markdownPath };
}
