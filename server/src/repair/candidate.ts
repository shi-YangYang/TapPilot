import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { RepairCandidateSchema, REPAIR_PATH, HELPERS, RepairError, sha256, type RepairCandidate } from "./schema.js";

const exec = promisify(execFile);
const gitEnv = { PATH: "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
export async function baselineSource(repo: string, sha: string): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new RepairError("INVALID_BASELINE");
  try {
    const { stdout } = await exec("/usr/bin/git", ["-C", repo, "show", `${sha}:${REPAIR_PATH}`], { env: gitEnv, timeout: 5000, maxBuffer: 128 * 1024 });
    return stdout;
  } catch { throw new RepairError("BASELINE_UNAVAILABLE"); }
}
export function helperSources(source: string): Record<string, string> {
  const file = ts.createSourceFile(REPAIR_PATH, source, ts.ScriptTarget.ES2022, true);
  const found: Record<string, string> = {};
  for (const node of file.statements) if (ts.isFunctionDeclaration(node) && node.name && HELPERS.includes(node.name.text as typeof HELPERS[number])) found[node.name.text] = node.getText(file);
  return found;
}
function validateReplacement(content: string, helper: string): void {
  const file = ts.createSourceFile(REPAIR_PATH, content, ts.ScriptTarget.ES2022, true);
  const nodes = file.statements;
  const fn = nodes[0];
  if (nodes.length !== 1 || !fn || !ts.isFunctionDeclaration(fn) || fn.name?.text !== helper || !fn.body || fn.asteriskToken || fn.modifiers?.length) throw new RepairError("HELPER_BOUNDARY_VIOLATION");
  const forbidden = new Set(["process", "require", "module", "exports", "global", "globalThis", "eval", "Function", "fetch", "WebAssembly", "Buffer", "Reflect", "Proxy", "constructor", "prototype", "__proto__", "setTimeout", "setInterval",
    "actionRejectionReason", "actionRejectionReasons", "projectError", "scalarFields", "UI_PROJECTION_LEGEND", "projectToolResult"]);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
      node.kind === ts.SyntaxKind.ImportKeyword || ts.isAwaitExpression(node) || ts.isNewExpression(node) && (!ts.isIdentifier(node.expression) || !["Map", "Set"].includes(node.expression.text)) ||
      ts.isIdentifier(node) && forbidden.has(node.text) || ts.isStringLiteral(node) && forbidden.has(node.text)) throw new RepairError("HELPER_CAPABILITY_DENIED");
    ts.forEachChild(node, visit);
  };
  visit(fn);
  const output = ts.transpileModule(content, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  if (output.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new RepairError("INVALID_CANDIDATE_SOURCE");
}
/** Only AST-delimited presentation helpers can change. All guards, error
 * whitelists, legends, imports and the tool-result interface remain byte-identical. */
export function applyCandidate(source: string, input: unknown): { candidate: RepairCandidate; source: string; candidateHash: string } {
  const parsed = RepairCandidateSchema.safeParse(input);
  if (!parsed.success) throw new RepairError("INVALID_CANDIDATE");
  const candidate = parsed.data;
  if (source.length > 128 * 1024 || sha256(source) !== candidate.sourceHash) throw new RepairError("SOURCE_HASH_MISMATCH");
  const file = ts.createSourceFile(REPAIR_PATH, source, ts.ScriptTarget.ES2022, true);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const seen = new Set<string>();
  for (const replacement of candidate.replacements) {
    if (seen.has(replacement.helper)) throw new RepairError("DUPLICATE_HELPER");
    seen.add(replacement.helper);
    const node = file.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === replacement.helper);
    if (!node || sha256(node.getText(file)) !== replacement.originalHash) throw new RepairError("HELPER_HASH_MISMATCH");
    validateReplacement(replacement.content, replacement.helper);
    edits.push({ start: node.getStart(file), end: node.end, text: replacement.content });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return { candidate, source: result, candidateHash: sha256(result) };
}
export function compileProjection(source: string): string {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new RepairError("INVALID_CANDIDATE_SOURCE");
  return result.outputText;
}
