import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "lore:is-public";

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
