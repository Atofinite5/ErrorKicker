import { z, type ZodIssue, type ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Stage A: schema + types (Zod). Cheapest checks run first (<1ms).
// .strict() turns unknown/extra fields into issues so A3 is caught here too.
// ---------------------------------------------------------------------------

const orderItemSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int(),
  price: z.number(),
});

export const orderSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    items: z.array(orderItemSchema).min(1),
    total: z.number(),
    currency: z.string().length(3),
    createdAt: z.string().min(1),
    deliverBy: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .strict();

export const userSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    email: z.string().email(),
    phone: z.string().optional(),
    age: z.number().int().optional(),
    signupAt: z.string().min(1),
  })
  .strict();

export const tableSchemas: Record<string, ZodTypeAny> = {
  orders: orderSchema,
  users: userSchema,
};

export function knownFields(table: string): string[] {
  const shape = (tableSchemas[table] as unknown as { shape: Record<string, unknown> })
    ?.shape;
  return shape ? Object.keys(shape) : [];
}

export type StageACheck = "A1_REQUIRED" | "A2_TYPE" | "A3_EXTRA";

/** Map the first Zod issue to its Stage A check id + a plain-language message. */
export function mapZodIssue(issue: ZodIssue): { check: StageACheck; message: string } {
  const path = issue.path.join(".") || "(root)";
  if (issue.code === "unrecognized_keys") {
    const keys = (issue as unknown as { keys: string[] }).keys.join(", ");
    return {
      check: "A3_EXTRA",
      message: `Unknown field${keys.includes(",") ? "s" : ""} ${keys} on ${path} — possible typo of a real field.`,
    };
  }
  if (issue.code === "invalid_type" && (issue as unknown as { received: string }).received === "undefined") {
    return { check: "A1_REQUIRED", message: `Missing required field: ${path}.` };
  }
  return { check: "A2_TYPE", message: `Field ${path}: ${issue.message}.` };
}
