import { createRequire } from 'node:module';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Candidate {
  clause: TS.ImportClause;
  bindings: TS.NamedImports;
  edits: Edit[];
  safe: boolean;
}

interface Binding {
  candidate: Candidate;
  exported: string;
}

/** Shortens long type-only imports without resolving modules or loading a project. */
export function compactTypeImports(content: string, fileName: string, printWidth: number): string {
  if (!/\bimport\s+type\s*\{/.test(content)) return content;

  const ts: typeof TS = require('typescript');
  const normalizePath = (name: string): string => name.replaceAll('\\', '/');
  const normalizedFileName = normalizePath(fileName);
  const source = ts.createSourceFile(normalizedFileName, content, ts.ScriptTarget.Latest, true);
  const candidates: Candidate[] = [];
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
    if (!clause?.isTypeOnly || clause.name || !bindings || !ts.isNamedImports(bindings)) continue;
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

    const attributes = statement.attributes;
    const suffix = attributes
      ? ` ${ts.tokenToString(attributes.token)} { ${attributes.elements.map((attribute) => `${attribute.name.getText(source)}: ${attribute.value.getText(source)}`).join(', ')} }`
      : '';
    const flat = `import type { ${bindings.elements.map((binding) => binding.getText(source)).join(', ')} } from ${statement.moduleSpecifier.getText(source)}${suffix};`;
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
  const program = ts.createProgram([normalizedFileName], { noResolve: true, noLib: true }, host);
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
  const visit = (node: TS.Node): void => {
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
        if (!qualified && !type && !query && !heritage) {
          binding.candidate.safe = false;
        } else {
          binding.candidate.edits.push({
            start: node.getStart(source),
            end: node.getEnd(),
            text: binding.exported,
          });
        }
      }
    }
    for (const doc of (node as TS.Node & { jsDoc?: readonly TS.JSDoc[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const edits: Edit[] = [];
  let suffix = 1;
  for (const candidate of candidates) {
    if (!candidate.safe) continue;
    let namespace = 't';
    while (identifiers.has(namespace)) namespace = `t${++suffix}`;
    identifiers.add(namespace);
    edits.push({
      start: candidate.clause.getStart(source),
      end: candidate.clause.getEnd(),
      text: `type * as ${namespace}`,
    });
    for (const edit of candidate.edits) edits.push({ ...edit, text: `${namespace}.${edit.text}` });
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
