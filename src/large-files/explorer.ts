import { truncateToTokenBudget } from '../tools/truncate.ts';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const EXPORT_PATTERN = /^export\s+(function|async\s+function|class|abstract\s+class|const|let|var|type|interface|enum|default|\{|\*\s+from)/;

const MAX_TOKENS = 500;
const PREVIEW_LINES = 60;

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot).toLowerCase();
}

function exploreTsJs(filePath: string, content: string): string {
  const lines = content.length === 0 ? [] : content.split('\n');
  const lineCount = lines.length;
  const exports: string[] = [];

  for (let i = 0; i < lineCount; i++) {
    const trimmed = lines[i].trimStart();
    if (EXPORT_PATTERN.test(trimmed)) {
      exports.push(`L${i + 1}: ${trimmed}`);
    }
  }

  const exportLabel = exports.length === 1 ? '1 export' : `${exports.length} exports`;
  const header = `# ${filePath}\n${lineCount} lines | ${exportLabel}\n`;
  const body = exports.length > 0 ? '\n' + exports.join('\n') + '\n' : '';

  return truncateToTokenBudget(header + body, MAX_TOKENS);
}

function exploreGeneric(filePath: string, content: string): string {
  const lines = content.length === 0 ? [] : content.split('\n');
  const lineCount = lines.length;
  const byteCount = content.length;

  const header = `# ${filePath}\n${lineCount} lines | ${byteCount} bytes\n`;

  if (lines.length === 0) {
    return truncateToTokenBudget(header, MAX_TOKENS);
  }

  const previewLines = lines.slice(0, PREVIEW_LINES);
  const preview = '\n' + previewLines.join('\n') + '\n';

  const remaining = lineCount - PREVIEW_LINES;
  const trailer = remaining > 0 ? `\n[...${remaining} more lines]\n` : '';

  return truncateToTokenBudget(header + preview + trailer, MAX_TOKENS);
}

export function explore(filePath: string, content: string): string {
  const ext = getExtension(filePath);
  if (TS_JS_EXTENSIONS.has(ext)) {
    return exploreTsJs(filePath, content);
  }
  return exploreGeneric(filePath, content);
}
