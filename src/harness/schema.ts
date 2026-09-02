/**
 * 最小の JSON Schema ビルダー。
 *
 * ツールのスキーマは「JSON Schema (モデルに送る)」「TypeScript 型 (実装で使う)」
 * 「実行時バリデータ (モデルの出力を検証する)」の 3 つが必要になるが、
 * 別々に書くと必ずズレる。ここでは 1 つの定義から 3 つとも導出する。
 */

export type JsonSchema = Record<string, unknown>;

export class SchemaError extends Error {
  constructor(readonly path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "SchemaError";
  }
}

export interface Schema<T> {
  readonly jsonSchema: JsonSchema;
  validate(value: unknown, path?: string): T;
}

/** obj() の中で「省略可」を表すマーカー付きスキーマ。 */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly __optional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

export type ObjectShape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends { __optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends ObjectShape> = Exclude<keyof S, OptionalKeys<S>>;

export type InferObject<S extends ObjectShape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function str(
  description: string,
  opts: { enum?: readonly string[]; maxLength?: number } = {}
): Schema<string> {
  const jsonSchema: JsonSchema = { type: "string", description };
  if (opts.enum) jsonSchema.enum = [...opts.enum];
  if (opts.maxLength) jsonSchema.maxLength = opts.maxLength;

  return {
    jsonSchema,
    validate(value, path = "") {
      if (typeof value !== "string") {
        throw new SchemaError(path, `expected string, got ${typeName(value)}`);
      }
      if (opts.enum && !opts.enum.includes(value)) {
        throw new SchemaError(path, `expected one of ${opts.enum.join(" | ")}, got ${JSON.stringify(value)}`);
      }
      return value;
    },
  };
}

export function num(
  description: string,
  opts: { int?: boolean; min?: number; max?: number } = {}
): Schema<number> {
  const jsonSchema: JsonSchema = { type: opts.int ? "integer" : "number", description };
  if (opts.min !== undefined) jsonSchema.minimum = opts.min;
  if (opts.max !== undefined) jsonSchema.maximum = opts.max;

  return {
    jsonSchema,
    validate(value, path = "") {
      // モデルは数値を文字列で返すことがあるので、数値として読めるなら受け入れる。
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new SchemaError(path, `expected number, got ${typeName(value)}`);
      }
      if (opts.int && !Number.isInteger(n)) {
        throw new SchemaError(path, `expected integer, got ${n}`);
      }
      if (opts.min !== undefined && n < opts.min) {
        throw new SchemaError(path, `expected >= ${opts.min}, got ${n}`);
      }
      if (opts.max !== undefined && n > opts.max) {
        throw new SchemaError(path, `expected <= ${opts.max}, got ${n}`);
      }
      return n;
    },
  };
}

export function bool(description: string): Schema<boolean> {
  return {
    jsonSchema: { type: "boolean", description },
    validate(value, path = "") {
      if (typeof value === "string" && (value === "true" || value === "false")) {
        return value === "true";
      }
      if (typeof value !== "boolean") {
        throw new SchemaError(path, `expected boolean, got ${typeName(value)}`);
      }
      return value;
    },
  };
}

export function arr<T>(item: Schema<T>, description: string): Schema<T[]> {
  return {
    jsonSchema: { type: "array", description, items: item.jsonSchema },
    validate(value, path = "") {
      if (!Array.isArray(value)) {
        throw new SchemaError(path, `expected array, got ${typeName(value)}`);
      }
      return value.map((v, i) => item.validate(v, `${path}[${i}]`));
    },
  };
}

export function obj<S extends ObjectShape>(shape: S, description?: string): Schema<InferObject<S>> {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = schema.jsonSchema;
    if (!("__optional" in schema)) required.push(key);
  }

  const jsonSchema: JsonSchema = {
    type: "object",
    properties,
    required,
    // 余計なキーを弾くことで「モデルが勝手に増やしたパラメータ」に気づける。
    additionalProperties: false,
  };
  if (description) jsonSchema.description = description;

  return {
    jsonSchema,
    validate(value, path = "") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SchemaError(path, `expected object, got ${typeName(value)}`);
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};

      for (const [key, schema] of Object.entries(shape)) {
        const childPath = path ? `${path}.${key}` : key;
        const raw = input[key];
        if (raw === undefined || raw === null) {
          if ("__optional" in schema) continue;
          throw new SchemaError(childPath, "is required but missing");
        }
        out[key] = schema.validate(raw, childPath);
      }

      const unknownKeys = Object.keys(input).filter((k) => !(k in shape));
      if (unknownKeys.length > 0) {
        throw new SchemaError(
          path,
          `unknown parameter(s): ${unknownKeys.join(", ")}. allowed: ${Object.keys(shape).join(", ")}`
        );
      }
      return out as InferObject<S>;
    },
  };
}

export function opt<T>(schema: Schema<T>): OptionalSchema<T> {
  return {
    __optional: true,
    jsonSchema: schema.jsonSchema,
    validate(value, path = "") {
      if (value === undefined || value === null) return undefined;
      return schema.validate(value, path);
    },
  };
}
