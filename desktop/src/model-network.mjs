import { session } from 'electron';

/** Use macOS/system proxy and certificate handling without sharing browser cookies or cache. */
export function createModelFetch(network = session.fromPartition('tappilot-model-network', { cache: false })) {
  return (input, init) => network.fetch(input, {
    ...init,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    bypassCustomProtocolHandlers: true
  });
}
