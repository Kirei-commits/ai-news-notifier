import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arr, bool, num, obj, opt, SchemaError, str } from "./schema.js";

describe("schema", () => {
  it("JSON Schema を生成する", () => {
    const schema = obj({
      name: str("名前"),
      count: opt(num("件数", { int: true, min: 1 })),
    });
    assert.deepEqual(schema.jsonSchema, {
      type: "object",
      properties: {
        name: { type: "string", description: "名前" },
        count: { type: "integer", description: "件数", minimum: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("必須キーの欠落を検出する", () => {
    const schema = obj({ name: str("名前") });
    assert.throws(() => schema.validate({}), (e: SchemaError) => /name: is required/.test(e.message));
  });

  it("省略可能キーは undefined になる", () => {
    const schema = obj({ name: str("名前"), note: opt(str("メモ")) });
    assert.deepEqual(schema.validate({ name: "a" }), { name: "a" });
    assert.deepEqual(schema.validate({ name: "a", note: "b" }), { name: "a", note: "b" });
    // モデルは省略の代わりに null を入れてくることがある
    assert.deepEqual(schema.validate({ name: "a", note: null }), { name: "a" });
  });

  it("未知のパラメータを弾いて候補を示す", () => {
    const schema = obj({ name: str("名前") });
    assert.throws(
      () => schema.validate({ name: "a", extra: 1 }),
      (e: SchemaError) => /unknown parameter\(s\): extra/.test(e.message) && /allowed: name/.test(e.message)
    );
  });

  it("enum を検証する", () => {
    const schema = str("種別", { enum: ["a", "b"] });
    assert.equal(schema.validate("a"), "a");
    assert.throws(() => schema.validate("c"), /expected one of a \| b/);
  });

  it("配列の要素ごとにパスを付ける", () => {
    const schema = arr(num("n"), "数値配列");
    assert.throws(() => schema.validate([1, "x"], "items"), /items\[1\]: expected number/);
  });

  it("boolean の文字列表現を受け入れる", () => {
    assert.equal(bool("f").validate("true"), true);
    assert.equal(bool("f").validate("false"), false);
    assert.throws(() => bool("f").validate("yes"), /expected boolean/);
  });

  it("ネストしたオブジェクトのパスを正しく出す", () => {
    const schema = obj({ inner: obj({ x: num("x") }) });
    assert.throws(() => schema.validate({ inner: { x: "abc" } }), /inner\.x: expected number/);
  });
});
