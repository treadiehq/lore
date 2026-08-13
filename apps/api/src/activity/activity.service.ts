import { Inject, Injectable } from "@nestjs/common";
import type { ActivityListResponse, ActivityQuery } from "@lore-co/core";
import type { PostgresPilotRepository } from "@lore-co/database";
import { PILOT_REPOSITORY } from "../common/tokens.js";

@Injectable()
export class ActivityService {
  readonly #repository: PostgresPilotRepository;

  constructor(
    @Inject(PILOT_REPOSITORY) repository: PostgresPilotRepository,
  ) {
    this.#repository = repository;
  }

  list(
    workspaceId: string,
    query: ActivityQuery = {},
  ): Promise<ActivityListResponse> {
    return this.#repository.listActivity({
      workspaceId,
      ...query,
    });
  }
}
