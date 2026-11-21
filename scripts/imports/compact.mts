import { createRequire } from 'node:module';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Reference extends Edit {
  shorthand?: string;
}

interface Candidate {
  clause: TS.ImportClause;
  bindings: TS.NamedImports;
  edits: Reference[];
  safe: boolean;
}

interface Binding {
  candidate: Candidate;
  exported: string;
}

/** Shortens long named imports without resolving modules or loading a project. */
export function compactImports(
  content: string,
  fileName: string,
  printWidth: number,
  includeRuntime = true,
): string {
  if (!/\bimport\s*(?:type\s*)?\{/.test(content)) return content;

  const ts: typeof TS = require('typescript');
  const normalizePath = (name: string): string => name.replaceAll('\\', '/');
  const normalizedFileName = normalizePath(fileName);
  const source = ts.createSourceFile(normalizedFileName, content, ts.ScriptTarget.Latest, true);
  const candidates: Candidate[] = [];
  const jsxBindings = new Set<string>();
  for (const comment of ts.getLeadingCommentRanges(content, 0) ?? []) {
    const text = content.slice(comment.pos, comment.end);
    for (const pragma of text.matchAll(/@jsx(?:Frag)?\s+([^\s*]+)/gi)) {
      jsxBindings.add(pragma[1].split('.')[0]);
    }
  }
  const importedNames = new Map<string, number>();
  const countName = (name: string): void => {
    importedNames.set(name, (importedNames.get(name) ?? 0) + 1);
  };

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (clause?.name) countName(clause.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) countName(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) countName(binding.name.text);
    }
    if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings)) continue;
    if (!includeRuntime && !clause.isTypeOnly) continue;
    if (
      !clause.isTypeOnly &&
      bindings.elements.some((binding) => jsxBindings.has(binding.name.text))
    ) {
      continue;
    }
    if (bindings.elements.some((binding) => binding.isTypeOnly)) continue;
    if (bindings.elements.length < 2) continue;
    if (
      bindings.elements.some(
        (binding) =>
          binding.propertyName &&
          (!ts.isIdentifier(binding.propertyName) || binding.propertyName.text === 'default'),
      )
    ) {
      continue;
    }

    const flat = `import ${clause.isTypeOnly ? 'type ' : ''}{ ${bindings.elements.map((binding) => binding.getText(source)).join(', ')} } from ${statement.moduleSpecifier.getText(source)};`;
    if (flat.length <= printWidth) continue;

    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      clause.getText(source),
    );
    let hasComment = false;
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        hasComment = true;
        break;
      }
    }
    if (hasComment) continue;
    candidates.push({ clause, bindings, edits: [], safe: true });
  }
  if (candidates.length === 0) return content;

  const host: TS.CompilerHost = {
    getSourceFile: (name) => (normalizePath(name) === normalizedFileName ? source : undefined),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: normalizePath,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => normalizePath(name) === normalizedFileName,
    readFile: (name) => (normalizePath(name) === normalizedFileName ? content : undefined),
  };
  const program = ts.createProgram(
    [normalizedFileName],
    { noResolve: true, noLib: true, allowJs: true },
    host,
  );
  if (program.getSyntacticDiagnostics(source).length > 0) return content;
  const checker = program.getTypeChecker();
  const bindings = new Map<TS.Symbol, Binding>();
  const bindingNames = new Set<string>();
  for (const candidate of candidates) {
    for (const binding of candidate.bindings.elements) {
      const symbol = checker.getSymbolAtLocation(binding.name);
      if (
        !symbol ||
        symbol.declarations?.length !== 1 ||
        importedNames.get(binding.name.text) !== 1
      ) {
        candidate.safe = false;
        continue;
      }
      bindings.set(symbol, { candidate, exported: (binding.propertyName ?? binding.name).text });
      bindingNames.add(binding.name.text);
    }
  }

  const identifiers = new Set<string>();
  let hasJsx = false;
  const unwrap = (node: TS.Node): TS.Node => {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isExpressionWithTypeArguments(node)
    )
      node = node.expression;
    return node;
  };
  const expressionRoot = (node: TS.Node): TS.Node => {
    while (node.parent && unwrap(node.parent) === unwrap(node)) node = node.parent;
    return node;
  };
  const isWrite = (node: TS.Node): boolean => {
    let target = expressionRoot(node);
    while (
      ts.isArrayLiteralExpression(target.parent) ||
      ts.isObjectLiteralExpression(target.parent) ||
      ts.isShorthandPropertyAssignment(target.parent) ||
      ts.isSpreadElement(target.parent) ||
      ts.isSpreadAssignment(target.parent) ||
      (ts.isPropertyAssignment(target.parent) && target.parent.initializer === target)
    )
      target = expressionRoot(target.parent);
    const parent = target.parent;
    return (
      (ts.isBinaryExpression(parent) &&
        parent.left === target &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
        parent.initializer === target) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isDeleteExpression(parent)
    );
  };
  const visit = (node: TS.Node): void => {
    if (
      ts.isJsxOpeningElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      hasJsx = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === 'eval') {
        for (const candidate of candidates)
          if (!candidate.clause.isTypeOnly) candidate.safe = false;
      }
    }
    if (ts.isIdentifier(node)) {
      identifiers.add(node.text);
      const parent = node.parent;
      if (ts.isImportSpecifier(parent) || !bindingNames.has(node.text)) return;
      let symbol: TS.Symbol | undefined;
      if (ts.isExportSpecifier(parent)) {
        symbol = checker.getExportSpecifierLocalTargetSymbol(parent);
      } else if (ts.isShorthandPropertyAssignment(parent)) {
        symbol = checker.getShorthandAssignmentValueSymbol(parent);
      } else {
        symbol = checker.getSymbolAtLocation(node);
      }
      const binding = symbol && bindings.get(symbol);
      if (binding) {
        const qualified = ts.isQualifiedName(parent) && parent.left === node;
        const type = ts.isTypeReferenceNode(parent) && parent.typeName === node;
        const query = ts.isTypeQueryNode(parent) && parent.exprName === node;
        const heritage = ts.isExpressionWithTypeArguments(parent) && parent.expression === node;
        const typeReference = qualified || type || query || heritage;
        const unsupported =
          ts.isExportSpecifier(parent) ||
          ts.isImportEqualsDeclaration(parent) ||
          ts.isJSDocLink(parent) ||
          ts.isJSDocLinkCode(parent) ||
          ts.isJSDocLinkPlain(parent);
        const root = expressionRoot(node);
        const directlyInvoked =
          (ts.isCallExpression(root.parent) && root.parent.expression === root) ||
          (ts.isTaggedTemplateExpression(root.parent) && root.parent.tag === root);
        if (
          unsupported ||
          directlyInvoked ||
          isWrite(node) ||
          (binding.candidate.clause.isTypeOnly && !typeReference)
        ) {
          binding.candidate.safe = false;
        } else {
          let shorthand: string | undefined;
          if (ts.isShorthandPropertyAssignment(parent)) {
            shorthand = node.text === '__proto__' ? "['__proto__']" : node.getText(source);
          }
          binding.candidate.edits.push({
            start: node.getStart(source),
            end: node.getEnd(),
            text: binding.exported,
            shorthand,
          });
        }
      }
    }
    for (const doc of (node as TS.Node & { jsDoc?: readonly TS.JSDoc[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const edits: Edit[] = [];
  for (const candidate of candidates) {
    if (!candidate.safe) continue;
    if (
      hasJsx &&
      !candidate.clause.isTypeOnly &&
      candidate.bindings.elements.some((binding) => binding.name.text === 'React')
    ) {
      continue;
    }
    const prefix = candidate.clause.isTypeOnly ? 't' : 'm';
    let suffix = 1;
    let namespace = prefix;
    while (identifiers.has(namespace)) namespace = `${prefix}${++suffix}`;
    identifiers.add(namespace);
    edits.push({
      start: candidate.clause.getStart(source),
      end: candidate.clause.getEnd(),
      text: `${candidate.clause.isTypeOnly ? 'type ' : ''}* as ${namespace}`,
    });
    for (const edit of candidate.edits) {
      let text = `${namespace}.${edit.text}`;
      if (edit.shorthand) text = `${edit.shorthand}: ${text}`;
      edits.push({ start: edit.start, end: edit.end, text });
    }
  }
  if (edits.length === 0) return content;

  edits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let start = 0;
  for (const edit of edits) {
    parts.push(content.slice(start, edit.start), edit.text);
    start = edit.end;
  }
  parts.push(content.slice(start));
  return parts.join('');
}
