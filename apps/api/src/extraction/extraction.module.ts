import { Global, Module } from "@nestjs/common";
import type { MemoryExtractor } from "@lore-co/core";
import { createMemoryExtractor } from "@lore-co/extractor";
import { MEMORY_EXTRACTOR } from "../common/tokens.js";

@Global()
@Module({
  providers: [
    {
      provide: MEMORY_EXTRACTOR,
      useFactory: (): MemoryExtractor => createMemoryExtractor(process.env),
    },
  ],
  exports: [MEMORY_EXTRACTOR],
})
export class ExtractionModule {}
