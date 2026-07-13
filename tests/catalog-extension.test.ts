import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCatalogSearchResult } from '../src/catalog.js';
import { catalogToolResult } from '../src/server.js';

const catalogFixture: Record<string, unknown> = {
  ucp: {
    version: '2026-04-08',
    capabilities: {
      'dev.ucp.shopping.catalog.search': [{ version: '2026-04-08' }],
      'dev.shopify.catalog.global': [{ version: '2026-04-08' }],
    },
  },
  products: [
    {
      id: 'gid://shopify/p/TestProduct',
      title: 'Trail Runner Pro',
      metadata: {
        attributes: [{ name: 'Material', value: 'Mesh' }],
        top_features: ['Lightweight'],
        unique_selling_points: ['Responsive foam midsole'],
      },
      variants: [
        {
          id: 'gid://shopify/ProductVariant/1',
          price: { amount: 8999, currency: 'USD' },
          checkout_url: 'https://merchant.example/cart/1:1',
          condition: ['new'],
          eligible: { native_checkout: true },
          availability: {
            available: true,
            status: 'in_stock',
            running_low: false,
          },
          requires: {
            shipping: true,
            components: false,
          },
          seller: {
            id: 'gid://shopify/Shop/1',
            name: 'Example Running',
            domain: 'merchant.example',
            url: 'https://merchant.example',
            links: [
              {
                type: 'refund_policy',
                url: 'https://merchant.example/policies/refund',
              },
            ],
          },
        },
      ],
    },
  ],
};

test('Catalog tool results preserve complete extension structured content', () => {
  const result = catalogToolResult('Concise buyer-facing summary', catalogFixture);

  assert.equal(result.content[0].text, 'Concise buyer-facing summary');
  assert.deepEqual(result.structuredContent, catalogFixture);
});

test('self-test summary detects Global Catalog extension coverage', () => {
  const summary = summarizeCatalogSearchResult(catalogFixture);

  assert.deepEqual(summary.globalCatalogExtension.versions, ['2026-04-08']);
  assert.equal(summary.globalCatalogExtension.productsWithMetadata, 1);
  assert.equal(summary.globalCatalogExtension.productsWithAttributes, 1);
  assert.equal(summary.globalCatalogExtension.productsWithTopFeatures, 1);
  assert.equal(summary.globalCatalogExtension.productsWithUniqueSellingPoints, 1);
  assert.equal(summary.globalCatalogExtension.totalVariants, 1);
  assert.equal(summary.globalCatalogExtension.variantsWithExtensionData, 1);
  assert.equal(summary.globalCatalogExtension.variantsWithCondition, 1);
  assert.equal(summary.globalCatalogExtension.variantsWithNativeCheckoutEligibility, 1);
  assert.equal(summary.globalCatalogExtension.variantsWithRunningLowSignal, 1);
  assert.equal(summary.globalCatalogExtension.variantsWithRequirements, 1);
  assert.equal(summary.globalCatalogExtension.variantsWithSellerIdentity, 1);
});
