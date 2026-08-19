import { Global, Module } from "@nestjs/common";
import type { MemoryExtractor } from "@lore-co/core";
import { createMemoryExtractor } from "@lore-co/extractor";
import {
  MEMORY_CONFLICT_ANALYZER,
  MEMORY_EXTRACTOR,
} from "../common/tokens.js";
import { createConfiguredConflictAnalyzer } from "./conflict-analyzer.js";

@Global()
@Module({
  providers: [
    {
      provide: MEMORY_EXTRACTOR,
      useFactory: (): MemoryExtractor => createMemoryExtractor(process.env),
    },
    {
      provide: MEMORY_CONFLICT_ANALYZER,
      useFactory: () => createConfiguredConflictAnalyzer(process.env),
    },
  ],
  exports: [MEMORY_CONFLICT_ANALYZER, MEMORY_EXTRACTOR],
})
export class ExtractionModule {}
