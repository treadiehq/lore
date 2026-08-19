import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import {
  SharedMemoryEngine,
  type AuthenticatedWorkspace,
  type UpdateWorkspaceLearningPolicy,
  type WorkspaceLearningPolicy,
} from "@lore-co/core";
import { SHARED_MEMORY_ENGINE } from "../common/tokens.js";

@Injectable()
export class WorkspacePolicyService {
  readonly #engine: SharedMemoryEngine;

  constructor(
    @Inject(SHARED_MEMORY_ENGINE) engine: SharedMemoryEngine,
  ) {
    this.#engine = engine;
  }

  get(workspace: AuthenticatedWorkspace): Promise<WorkspaceLearningPolicy> {
    return this.#engine.getWorkspaceLearningPolicy(workspace.workspaceId);
  }

  async update(
    input: UpdateWorkspaceLearningPolicy,
    workspace: AuthenticatedWorkspace,
  ): Promise<WorkspaceLearningPolicy> {
    try {
      return await this.#engine.updateWorkspaceLearningPolicy(
        workspace.workspaceId,
        input,
      );
    } catch {
      throw new InternalServerErrorException(
        "Workspace policy could not be updated",
      );
    }
  }
}
