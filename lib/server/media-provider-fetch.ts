/**
 * The pinned transport for image/video provider requests.
 *
 * A provider base URL may come from the caller (honored when the provider is
 * not server-managed) and runs under the operator address policy — the one the
 * routes validated it against (`allowLocalNetworks` unset falls back to
 * ALLOW_LOCAL_NETWORKS), so a self-hosted provider on a local network keeps
 * working when the operator opted in. The connect address is pinned to the
 * vetted DNS answers and a 3xx is refused rather than followed.
 *
 * The adapters live in modules the settings UI also imports, so they cannot
 * import this server transport themselves; every server caller injects it
 * through the config's `fetchImpl`.
 */
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
import type { MediaProviderFetch } from '@/lib/media/types';

const MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  rejectRedirects: true,
};

export const mediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, MEDIA_PROVIDER_POLICY);

/** `config` with the pinned media transport installed. */
export function withMediaProviderFetch<T extends object>(
  config: T,
): T & { fetchImpl: MediaProviderFetch } {
  return { ...config, fetchImpl: mediaProviderFetch };
}
