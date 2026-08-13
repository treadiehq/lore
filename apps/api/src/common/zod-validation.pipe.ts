import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import { z, type ZodType } from "zod";

function validationException(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: "Bad Request",
    message: "Request validation failed",
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

export function parseWithSchema<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationException(result.error);
  }
  return result.data;
}

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  readonly #schema: ZodType<T>;

  constructor(schema: ZodType<T>) {
    this.#schema = schema;
  }

  transform(value: unknown): T {
    return parseWithSchema(this.#schema, value);
  }
}
