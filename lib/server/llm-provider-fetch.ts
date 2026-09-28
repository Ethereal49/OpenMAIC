/**
 * The pinned transport for LLM calls to a client-supplied base URL.
 */
import { LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';

// A client-supplied base URL runs under the operator address policy (the one
// `validateUrlForSSRF` applied: `allowLocalNetworks` unset falls back to
// ALLOW_LOCAL_NETWORKS) on the strict transport, which pins the connect address
// to the vetted DNS answers and refuses a 3xx. The pinned dispatcher carries the
// same long timeouts as the default LLM dispatcher, so slow thinking models and
// long streams are not cut off.
const CLIENT_BASE_URL_LLM_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  rejectRedirects: true,
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
};

/**
 * `fetch` for LLM calls to a client-supplied base URL. Any dispatcher already
 * on the request (the default timeout-only one) is replaced by the pinned one.
 */
export const clientBaseUrlLlmFetch: typeof fetch = (input, init) =>
  providerFetch(input instanceof Request ? input.url : input, init, CLIENT_BASE_URL_LLM_POLICY);
