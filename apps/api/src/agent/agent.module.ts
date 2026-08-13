import { Global, Module } from "@nestjs/common";
import {
  SharedMemoryEngine,
  type MemoryExtractor,
  type MemoryRepository,
  type MemoryRetriever,
} from "@lore-co/core";
import { parseExtractorMinConfidence } from "@lore-co/extractor";
import {
  MEMORY_EXTRACTOR,
  MEMORY_REPOSITORY,
  MEMORY_RETRIEVER,
  SHARED_MEMORY_ENGINE,
} from "../common/tokens.js";
import { DatabaseModule } from "../database/database.module.js";
import { ExtractionModule } from "../extraction/extraction.module.js";
import { RetrievalModule } from "../retrieval/retrieval.module.js";

@Global()
@Module({
  imports: [DatabaseModule, ExtractionModule, RetrievalModule],
  providers: [
    {
      provide: SHARED_MEMORY_ENGINE,
      inject: [MEMORY_REPOSITORY, MEMORY_EXTRACTOR, MEMORY_RETRIEVER],
      useFactory: (
        repository: MemoryRepository,
        extractor: MemoryExtractor,
        retriever: MemoryRetriever,
      ): SharedMemoryEngine =>
        new SharedMemoryEngine({
          repository,
          extractor,
          retriever,
          minimumConfidence: parseExtractorMinConfidence(process.env),
        }),
    },
  ],
  exports: [SHARED_MEMORY_ENGINE],
})
export class AgentModule {}
