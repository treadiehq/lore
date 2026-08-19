import { Global, Module } from "@nestjs/common";
import {
  ScopedMemoryConflictDetector,
  SharedMemoryEngine,
  type MemoryConflictAnalyzer,
  type MemoryExtractor,
  type MemoryRepository,
  type MemoryRetriever,
} from "@lore-co/core";
import { parseExtractorMinConfidence } from "@lore-co/extractor";
import {
  MEMORY_CONFLICT_ANALYZER,
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
      inject: [
        MEMORY_REPOSITORY,
        MEMORY_EXTRACTOR,
        MEMORY_RETRIEVER,
        MEMORY_CONFLICT_ANALYZER,
      ],
      useFactory: (
        repository: MemoryRepository,
        extractor: MemoryExtractor,
        retriever: MemoryRetriever,
        conflictAnalyzer: MemoryConflictAnalyzer | null,
      ): SharedMemoryEngine =>
        new SharedMemoryEngine({
          repository,
          extractor,
          retriever,
          conflictDetector: new ScopedMemoryConflictDetector(
            retriever,
            conflictAnalyzer ?? undefined,
          ),
          minimumConfidence: parseExtractorMinConfidence(process.env),
        }),
    },
  ],
  exports: [SHARED_MEMORY_ENGINE],
})
export class AgentModule {}
