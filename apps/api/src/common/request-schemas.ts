import {
  CorrectMemoryDtoSchema,
  CreateMemoryDtoSchema,
  ListMemoriesDtoSchema,
  MemoryCategorySchema,
  MemoryScopeSchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  type CorrectMemoryDto,
  type CreateMemoryDto,
  type ListMemoriesDto,
  type MemoryScope,
  type MemoryUpdate,
} from "@lore-co/core";
import { z } from "zod";

const scopeFields = {
  scope: MemoryScopeSchema.optional(),
  organization: z.string().trim().min(1).optional(),
  project: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  component: z.string().trim().min(1).optional(),
};

function normalizeScope(input: {
  scope?: MemoryScope | undefined;
  organization?: string | undefined;
  project?: string | undefined;
  repo?: string | undefined;
  path?: string | undefined;
  component?: string | undefined;
}): MemoryScope {
  return MemoryScopeSchema.parse({
    ...(input.scope?.organization ?? input.organization) === undefined
      ? {}
      : { organization: input.scope?.organization ?? input.organization },
    ...(input.scope?.project ?? input.project) === undefined
      ? {}
      : { project: input.scope?.project ?? input.project },
    ...(input.scope?.repo ?? input.repo) === undefined
      ? {}
      : { repo: input.scope?.repo ?? input.repo },
    ...(input.scope?.path ?? input.path) === undefined
      ? {}
      : { path: input.scope?.path ?? input.path },
    ...(input.scope?.component ?? input.component) === undefined
      ? {}
      : { component: input.scope?.component ?? input.component },
  });
}

export const MemoryIdParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export const CreateMemoryBodySchema = z
  .object({
    content: z.string().trim().min(1),
    ...scopeFields,
    category: MemoryCategorySchema.optional(),
    source: MemorySourceSchema,
  })
  .strict()
  .superRefine((input, context) => {
    for (const field of [
      "organization",
      "project",
      "repo",
      "path",
      "component",
    ] as const) {
      const nested = input.scope?.[field];
      const flat = input[field];
      if (nested !== undefined && flat !== undefined && nested !== flat) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Conflicting ${field} values were provided`,
        });
      }
    }
  })
  .transform(
    (input): CreateMemoryDto =>
      CreateMemoryDtoSchema.parse({
        content: input.content,
        scope: normalizeScope(input),
        ...(input.category === undefined ? {} : { category: input.category }),
        source: input.source,
      }),
  );

export const UpdateMemoryBodySchema = z
  .object({
    content: z.string().trim().min(1).optional(),
    scope: MemoryScopeSchema.optional(),
    category: MemoryCategorySchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.content !== undefined ||
      input.scope !== undefined ||
      input.category !== undefined,
    { message: "At least one editable field is required" },
  )
  .transform((input): MemoryUpdate => input);

export const CorrectMemoryBodySchema = z
  .object({
    content: z.string().trim().min(1),
    category: MemoryCategorySchema.optional(),
    scope: MemoryScopeSchema.optional(),
    source: MemorySourceSchema.optional(),
  })
  .strict();

function splitCommaSeparated(value: unknown): unknown {
  if (typeof value !== "string" || !value.includes(",")) {
    return value;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const ListMemoriesQuerySchema = z
  .object({
    query: z.string().trim().min(1).optional(),
    category: z
      .preprocess(
        splitCommaSeparated,
        z.union([
          MemoryCategorySchema,
          z.array(MemoryCategorySchema).min(1),
        ]),
      )
      .optional(),
    status: z
      .preprocess(
        splitCommaSeparated,
        z.union([MemoryStatusSchema, z.array(MemoryStatusSchema).min(1)]),
      )
      .optional(),
    organization: z.string().trim().min(1).optional(),
    project: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    component: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
  .transform(
    (input): ListMemoriesDto =>
      ListMemoriesDtoSchema.parse({
        ...((input.organization === undefined &&
          input.project === undefined &&
          input.repo === undefined &&
          input.path === undefined &&
          input.component === undefined)
          ? {}
          : {
              scope: {
                ...(input.organization === undefined
                  ? {}
                  : { organization: input.organization }),
                ...(input.project === undefined
                  ? {}
                  : { project: input.project }),
                ...(input.repo === undefined ? {} : { repo: input.repo }),
                ...(input.path === undefined ? {} : { path: input.path }),
                ...(input.component === undefined
                  ? {}
                  : { component: input.component }),
              },
            }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.category === undefined
          ? {}
          : { category: input.category }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      }),
  );

export function correctionInput(
  memoryId: string,
  body: z.infer<typeof CorrectMemoryBodySchema>,
): CorrectMemoryDto {
  return CorrectMemoryDtoSchema.parse({ memoryId, ...body });
}
