import ts from "typescript"

/** Extract static dictionary keys without treating comments or bilingual copy as lookups. */
export function translationKeys(text: string, file = "source.tsx") {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const keys: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const named =
        (ts.isIdentifier(callee) && callee.text === "t") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "t") ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression) &&
          callee.argumentExpression.text === "t")
      const key = node.arguments[0]
      const fallback = node.arguments[1]
      // 字典的第二参数是插值对象；本地双语 helper 的第二参数是另一段文案。
      if (named && key && ts.isStringLiteralLike(key) && !(fallback && ts.isStringLiteralLike(fallback)))
        keys.push(key.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return keys
}
