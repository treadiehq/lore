import packageMetadata from "../package.json" with { type: "json" };

declare const __LORE_VERSION__: string | undefined;
declare const __LORE_STANDALONE__: boolean | undefined;

export const LORE_VERSION =
  typeof __LORE_VERSION__ === "string" && __LORE_VERSION__ !== ""
    ? __LORE_VERSION__
    : packageMetadata.version;

export const IS_STANDALONE_BINARY =
  typeof __LORE_STANDALONE__ === "boolean" && __LORE_STANDALONE__;
