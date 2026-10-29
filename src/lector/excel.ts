// Abre un .xlsx con ExcelJS y entrega sus hojas como una cuadrícula simple de valores.
// Resuelve las celdas combinadas: ExcelJS devuelve el valor de la celda principal en todas
// las celdas de una combinación, y eso hace que una fila de sección combinada A:AD parezca
// tener 30 valores. Aquí las celdas secundarias se pueden ignorar.
import ExcelJS from 'exceljs';

export type ValorCelda = string | number | boolean | Date | null;

export interface Hoja {
  nombre: string;
  filas: number;
  columnas: number;
  /** Valor de la celda; null si está vacía o si es una celda secundaria de una combinación */
  valor(fila: number, col: number): ValorCelda;
  /** Valor de la celda; en una combinación devuelve el de su celda principal */
  valorConCombinadas(fila: number, col: number): ValorCelda;
}

export class ErrorArchivo extends Error {}

function desenvolver(v: ExcelJS.CellValue): ValorCelda {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return desenvolver((v.result ?? null) as ExcelJS.CellValue);
    if ('text' in v) return desenvolver(v.text as ExcelJS.CellValue);
    if ('error' in v) return String(v.error);
  }
  return String(v);
}

function hojaDesdeWorksheet(ws: ExcelJS.Worksheet): Hoja {
  return {
    nombre: ws.name,
    filas: ws.rowCount,
    columnas: ws.columnCount,
    valor(fila, col) {
      const celda = ws.getCell(fila, col);
      if (celda.isMerged && celda.master.address !== celda.address) return null;
      return desenvolver(celda.value);
    },
    valorConCombinadas(fila, col) {
      const celda = ws.getCell(fila, col);
      return desenvolver(celda.isMerged ? celda.master.value : celda.value);
    },
  };
}

function hojasDelLibro(wb: ExcelJS.Workbook): Hoja[] {
  return wb.worksheets.filter((ws) => ws.state !== 'veryHidden').map(hojaDesdeWorksheet);
}

export async function abrirExcel(ruta: string): Promise<Hoja[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(ruta);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') throw err;
    throw new ErrorArchivo(
      'El archivo no se pudo abrir como Excel .xlsx. ' +
        'Expórtalo otra vez desde BISS en formato Excel y no lo guardes como .xls ni .csv.',
    );
  }
  return hojasDelLibro(wb);
}

export async function abrirExcelDesdeBuffer(datos: ArrayBuffer | Uint8Array): Promise<Hoja[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(datos as ArrayBuffer);
  } catch {
    throw new ErrorArchivo(
      'El archivo no se pudo abrir como Excel .xlsx. ' +
        'Expórtalo otra vez desde BISS en formato Excel y no lo guardes como .xls ni .csv.',
    );
  }
  return hojasDelLibro(wb);
}
