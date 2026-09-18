export { defineCordisPluginConfig, isLocalPackage, LOCAL_PACKAGE_PREFIX } from "./cordis-host.ts";
export {
  bundleClientFactory,
  clientBundleSpec,
  clientEntryPlugin,
  CLIENT_ENTRY,
  isClientExternal,
} from "./cordis-client.ts";
export type { ClientBundleSpec, ClientFactoryOptions } from "./cordis-client.ts";
export type { CordisClientOptions } from "./cordis-client.ts";
