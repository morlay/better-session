import { Token } from "./styling/token.ts";
import { designTokens } from "./theme.generated.ts";

export { designTokens };
export const dsw = Token.vars(designTokens, { prefix: "dsw" });
