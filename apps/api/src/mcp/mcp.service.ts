import { Inject, Injectable } from "@nestjs/common";
import { SharedMemoryEngine } from "@lore-co/core";
import { SHARED_MEMORY_ENGINE } from "../common/tokens.js";

@Injectable()
export class McpService {
  readonly engine: SharedMemoryEngine;

  constructor(@Inject(SHARED_MEMORY_ENGINE) engine: SharedMemoryEngine) {
    this.engine = engine;
  }
}
