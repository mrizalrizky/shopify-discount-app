import { formatMoney, parseMoney } from "../domain/pricing/money";
import type { CatalogIndex, Target } from "../domain/sales/resolver";
import {
  MARKER_KEY,
  MARKER_NAMESPACE,
  parseMarker,
  serializeMarker,
  type ShopifyGateway,
  type VariantState,
} from "./gateway";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GraphqlFn = (query: string, variables?: Record<string, unknown>) => Promise<any>;

const PAGE_SIZE = 250;

const COLLECTION_PRODUCTS = `#graphql
query CollectionProducts($id: ID!, $after: String) {
  collection(id: $id) { products(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
}`;

const PRODUCT_VARIANTS = `#graphql
query ProductVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
}`;

const VARIANT_PRODUCTS = `#graphql
query VariantProducts($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant { id product { id } } }
}`;

const VARIANT_STATES = `#graphql
query VariantStates($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      price
      compareAtPrice
      product { id }
      metafield(namespace: "${MARKER_NAMESPACE}", key: "${MARKER_KEY}") { value }
    }
  }
}`;

const VARIANTS_BULK_UPDATE = `#graphql
mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message code } }
}`;

const CLEAR_SALE_MARKERS = `#graphql
mutation ClearSaleMarkers($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { userErrors { field message } }
}`;

const PRODUCT_TAGS = `#graphql
query ProductTags($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Product { id tags } }
}`;

const ADD_TAGS = `#graphql
mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;

const REMOVE_TAGS = `#graphql
mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`;

export function createGraphqlGateway(graphql: GraphqlFn): ShopifyGateway {
  return {
    async loadCatalog(targets: readonly Target[]): Promise<CatalogIndex> {
      const collectionProducts = new Map<string, string[]>();
      const productIds = new Set<string>();
      const variantTargets: string[] = [];

      for (const target of targets) {
        if (target.kind === "collection" && !collectionProducts.has(target.id)) {
          const ids = await paginate(graphql, COLLECTION_PRODUCTS, { id: target.id }, (d) => d.collection?.products);
          collectionProducts.set(target.id, ids);
          ids.forEach((id) => productIds.add(id));
        } else if (target.kind === "product") {
          productIds.add(target.id);
        } else if (target.kind === "variant") {
          variantTargets.push(target.id);
        }
      }
      for (const ids of chunks(variantTargets, PAGE_SIZE)) {
        const data = await graphql(VARIANT_PRODUCTS, { ids });
        for (const node of data.nodes) if (node?.product) productIds.add(node.product.id);
      }

      const productVariants = new Map<string, string[]>();
      for (const id of productIds) {
        productVariants.set(id, await paginate(graphql, PRODUCT_VARIANTS, { id }, (d) => d.product?.variants));
      }
      return { collectionProducts, productVariants };
    },

    async getVariants(variantIds) {
      const states = new Map<string, VariantState>();
      for (const ids of chunks(variantIds, PAGE_SIZE)) {
        const data = await graphql(VARIANT_STATES, { ids });
        for (const node of data.nodes) {
          if (!node?.id || !node.product) continue;
          states.set(node.id, {
            variantId: node.id,
            productId: node.product.id,
            price: parseMoney(node.price),
            compareAt: node.compareAtPrice === null ? null : parseMoney(node.compareAtPrice),
            marker: parseMarker(node.metafield?.value),
          });
        }
      }
      return states;
    },

    async writePrices(productId, writes) {
      if (writes.length === 0) return;
      const variants = writes.map((w) => ({
        id: w.variantId,
        price: formatMoney(w.price),
        compareAtPrice: w.compareAt === null ? null : formatMoney(w.compareAt),
        ...(w.marker
          ? {
              metafields: [
                { namespace: MARKER_NAMESPACE, key: MARKER_KEY, type: "json", value: serializeMarker(w.marker) },
              ],
            }
          : {}),
      }));
      const data = await graphql(VARIANTS_BULK_UPDATE, { productId, variants });
      assertNoUserErrors(data.productVariantsBulkUpdate.userErrors);
    },

    async clearMarkers(variantIds) {
      for (const ids of chunks(variantIds, PAGE_SIZE)) {
        const metafields = ids.map((ownerId) => ({ ownerId, namespace: MARKER_NAMESPACE, key: MARKER_KEY }));
        const data = await graphql(CLEAR_SALE_MARKERS, { metafields });
        assertNoUserErrors(data.metafieldsDelete.userErrors);
      }
    },

    async getProductTags(productIds) {
      const tags = new Map<string, string[]>();
      for (const ids of chunks(productIds, PAGE_SIZE)) {
        const data = await graphql(PRODUCT_TAGS, { ids });
        for (const node of data.nodes) if (node?.id) tags.set(node.id, node.tags ?? []);
      }
      return tags;
    },

    async addTags(productId, tags) {
      if (tags.length === 0) return;
      const data = await graphql(ADD_TAGS, { id: productId, tags });
      assertNoUserErrors(data.tagsAdd.userErrors);
    },

    async removeTags(productId, tags) {
      if (tags.length === 0) return;
      const data = await graphql(REMOVE_TAGS, { id: productId, tags });
      assertNoUserErrors(data.tagsRemove.userErrors);
    },
  };
}

interface Connection {
  nodes: { id: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function paginate(
  graphql: GraphqlFn,
  query: string,
  variables: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pick: (data: any) => Connection | null | undefined,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const connection = pick(await graphql(query, { ...variables, after }));
    if (!connection) return ids;
    ids.push(...connection.nodes.map((n) => n.id));
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function assertNoUserErrors(errors: { message: string }[] | undefined): void {
  if (errors && errors.length > 0) {
    throw new ShopifyGraphqlError(errors.map((e) => e.message).join("; "), false);
  }
}

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly throttled: boolean,
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

export interface AdminLike {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wraps the template's admin client: unwraps `data`, raises typed errors, retries throttling. */
export function adminGraphql(admin: AdminLike, sleep = defaultSleep): GraphqlFn {
  return (query, variables) =>
    withThrottleRetry(async () => {
      let body;
      try {
        const response = await admin.graphql(query, { variables });
        body = await response.json();
      } catch (error) {
        throw await toGraphqlError(error);
      }
      const errors = body.errors;
      if (Array.isArray(errors) ? errors.length > 0 : errors) throw await toGraphqlError(errors);
      return body.data;
    }, sleep);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isThrottledGraphqlErrors(list: any): boolean {
  return (
    Array.isArray(list) &&
    list.some((e) => e?.extensions?.code === "THROTTLED" || /throttled/i.test(String(e?.message ?? "")))
  );
}

/**
 * Classifies by structure (GraphqlQueryError with THROTTLED extension, HTTP 429 on
 * HttpResponseError/HttpThrottlingError, thrown Response) with a message fallback.
 */
async function toGraphqlError(error: unknown): Promise<ShopifyGraphqlError> {
  if (error instanceof ShopifyGraphqlError) return error;

  // The app-react-router admin client rethrows HTTP errors as a Response.
  if (typeof Response !== "undefined" && error instanceof Response) {
    let detail = "";
    try {
      detail = (await error.text()).slice(0, 500);
    } catch {
      // body unreadable; status is enough
    }
    const message = `HTTP ${error.status} ${error.statusText}`.trim() + (detail ? `: ${detail}` : "");
    return new ShopifyGraphqlError(message, error.status === 429);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = error as any;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  const graphQLErrors = Array.isArray(e?.body?.errors?.graphQLErrors)
    ? e.body.errors.graphQLErrors
    : Array.isArray(e?.graphQLErrors)
      ? e.graphQLErrors
      : Array.isArray(e)
        ? e
        : null;
  const throttled =
    isThrottledGraphqlErrors(graphQLErrors) ||
    e?.response?.code === 429 ||
    e?.response?.status === 429 ||
    e?.status === 429 ||
    /throttl/i.test(message);
  return new ShopifyGraphqlError(message, throttled);
}

export async function withThrottleRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  retries = 5,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const throttled = error instanceof ShopifyGraphqlError && error.throttled;
      if (!throttled || attempt >= retries) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
