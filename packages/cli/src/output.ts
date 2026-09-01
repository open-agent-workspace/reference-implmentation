export function printValue(value, { json = false, stream = process.stdout } : any = {}) {
  if (json) {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') {
    stream.write(`${value}\n`);
    return;
  }
  if (Array.isArray(value)) {
    printTable(value, { stream });
    return;
  }
  printRecord(value, { stream });
}

export function printTable(rows: any[], { stream = process.stdout } : any = {}) {
  if (!rows.length) {
    stream.write('No records.\n');
    return;
  }
  const columns: string[] = [...new Set<string>(rows.flatMap((row) => Object.keys(row)))];
  const rendered: string[][] = rows.map((row) => columns.map((column) => formatCell(row[column])));
  const widths = columns.map((column, index) => Math.max(column.length, ...rendered.map((row) => row[index].length)));
  stream.write(`${columns.map((column, index) => column.toUpperCase().padEnd(widths[index])).join('  ')}\n`);
  for (const row of rendered) {
    stream.write(`${row.map((cell, index) => cell.padEnd(widths[index])).join('  ')}\n`);
  }
}

function printRecord(record, { stream }) {
  for (const [key, value] of Object.entries(record ?? {})) {
    stream.write(`${key}: ${formatCell(value)}\n`);
  }
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
