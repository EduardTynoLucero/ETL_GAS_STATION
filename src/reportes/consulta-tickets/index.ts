// Lectura completa del reporte "Consulta de Tickets": encabezado, filas, conversión, reglas y cuadre.
// No toca la base de datos: lo mismo sirve para "validar" un archivo y para cargarlo.
import { Decimal } from 'decimal.js';
import { abrirExcel, type Hoja, type ValorCelda } from '../../lector/excel.js';
import { clasificarFila } from './clasificador.js';
import { aDecimal, aEntero, aFechaHora, aTexto, ValorInvalido } from './conversion.js';
import { cuadrar, leerSubtotal } from './cuadre.js';
import { leerEncabezado, type Encabezado } from './encabezado.js';
import { aplicarReglas, codigoEstacion } from './reglas.js';
import {
  CAMPOS_TEXTO,
  ESCALAS,
  type CampoNumero,
  type Grupo,
  type Incidencia,
  type ResultadoLectura,
  type Subtotal,
  type Ticket,
} from './tipos.js';

export interface OpcionesLectura {
  /** Estación para los archivos que no traen la columna Estación, por ejemplo "PCONC - GASOLINERA CONCEPCION LAS MINAS" */
  estacion?: string;
}

const SIN_SECCION = '(sin sección)';

function leerTicket(
  hoja: Hoja,
  enc: Encabezado,
  fila: number,
  seccion: string | null,
  opciones: OpcionesLectura,
  incidencias: Incidencia[],
): Ticket | null {
  const celda = (campo: keyof typeof enc.col): ValorCelda => {
    const c = enc.col[campo];
    return c ? hoja.valor(fila, c) : null;
  };
  let valido = true;
  const error = (regla: string, columna: string, valor: ValorCelda, mensaje: string) => {
    valido = false;
    incidencias.push({ severidad: 'ERROR', regla, fila, columna, valor: valor === null ? '' : String(valor), mensaje });
  };
  const entero = (campo: 'turno' | 'ticket' | 'bomba', obligatorio: boolean): number | null => {
    const v = celda(campo);
    try {
      const n = aEntero(v);
      if (n === null && obligatorio) error('VALOR_OBLIGATORIO_FALTA', campo, v, `Fila ${fila}: falta ${campo}`);
      return n;
    } catch (err) {
      if (!(err instanceof ValorInvalido)) throw err;
      error('NUMERO_INVALIDO', campo, v, `Fila ${fila}, ${campo}: ${err.message}`);
      return null;
    }
  };

  const ticket = entero('ticket', true);
  const turno = entero('turno', true);
  const bomba = entero('bomba', false);

  let fecha_hora = '';
  const vFecha = celda('fecha_hora');
  try {
    fecha_hora = aFechaHora(vFecha);
  } catch (err) {
    if (!(err instanceof ValorInvalido)) throw err;
    error('FECHA_INVALIDA', 'fecha_hora', vFecha, `Fila ${fila}, ticket ${ticket ?? '?'}: ${err.message}`);
  }

  const numeros = {} as Record<CampoNumero, Decimal | null>;
  for (const campo of Object.keys(ESCALAS) as CampoNumero[]) {
    const v = celda(campo);
    try {
      numeros[campo] = aDecimal(v);
    } catch (err) {
      if (!(err instanceof ValorInvalido)) throw err;
      error('NUMERO_INVALIDO', campo, v, `Fila ${fila}, ticket ${ticket ?? '?'}, ${campo}: ${err.message}`);
      numeros[campo] = null;
    }
  }
  for (const campo of ['cantidad', 'total', 'costo_total'] as const) {
    if (numeros[campo] === null && valido) {
      error('VALOR_OBLIGATORIO_FALTA', campo, null, `Fila ${fila}, ticket ${ticket}: falta ${campo}`);
    }
  }

  const textos = {} as Record<(typeof CAMPOS_TEXTO)[number], string | null>;
  for (const campo of CAMPOS_TEXTO) textos[campo] = aTexto(celda(campo));
  const estacion = textos.estacion?.trim() || opciones.estacion?.trim() || '';
  if (!estacion) valido = false; // se avisa una sola vez, en procesarHojas

  if (!valido || ticket === null || turno === null) return null;
  return { fila, seccion, ...textos, estacion, turno, ticket, bomba, fecha_hora, ...numeros };
}

/** Procesa las hojas ya abiertas (se usa directo en las pruebas) */
export function procesarHojas(hojas: Hoja[], opciones: OpcionesLectura = {}): ResultadoLectura {
  const { encabezado: enc, incidencias } = leerEncabezado(hojas);
  const vacio: ResultadoLectura = {
    hoja: enc?.hoja.nombre ?? hojas[0]?.nombre ?? '',
    filaEncabezado: enc?.filaEncabezado ?? 0,
    columnas: enc?.columnas ?? [],
    traeEstacion: Boolean(enc?.col.estacion),
    tickets: [],
    grupos: [],
    totalGeneral: null,
    cuadre: [],
    incidencias,
    resumen: { estaciones: [], turnoMin: null, turnoMax: null, fechaMin: null, fechaMax: null, total: '0', cantidad: '0' },
  };
  if (!enc || incidencias.some((i) => i.severidad === 'ERROR')) return vacio;
  if (!enc.col.estacion && !opciones.estacion?.trim()) {
    incidencias.push({
      severidad: 'ERROR',
      regla: 'ESTACION_FALTA',
      columna: 'estacion',
      mensaje:
        'El archivo no trae la columna Estación. Indica la estación con --estacion "PCONC - GASOLINERA CONCEPCION LAS MINAS" ' +
        'o con ETL_ESTACION_POR_DEFECTO en el .env',
    });
    return vacio;
  }

  const { hoja } = enc;
  const tickets: Ticket[] = [];
  const grupos: Grupo[] = [];
  let totalGeneral: Subtotal | null = null;
  let seccion: string | null = null;
  let pendientes: Ticket[] = [];
  let filasPendientes = 0;
  let faltaEstacion = false;

  const cerrarSinSubtotal = (motivo: string) => {
    if (filasPendientes === 0) return;
    incidencias.push({
      severidad: 'ERROR',
      regla: 'GRUPO_SIN_SUBTOTAL',
      mensaje: `${filasPendientes} tickets de ${seccion ?? SIN_SECCION} no tienen fila de subtotal (${motivo}). ¿El archivo está incompleto?`,
    });
    pendientes = [];
    filasPendientes = 0;
  };

  for (let fila = enc.filaInicioDatos; fila <= hoja.filas; fila++) {
    const tipo = clasificarFila(hoja, enc, fila);
    switch (tipo.tipo) {
      case 'vacia':
        break;
      case 'seccion':
        cerrarSinSubtotal(`empieza la sección ${tipo.nombre} en la fila ${fila}`);
        seccion = tipo.nombre;
        break;
      case 'ticket': {
        filasPendientes++;
        const t = leerTicket(hoja, enc, fila, seccion, opciones, incidencias);
        if (t) {
          tickets.push(t);
          pendientes.push(t);
        } else if (!faltaEstacion && !(aTexto(enc.col.estacion ? hoja.valor(fila, enc.col.estacion) : null) || opciones.estacion)) {
          faltaEstacion = true;
        }
        break;
      }
      case 'subtotal': {
        const subtotal = leerSubtotal(hoja, enc, fila, incidencias);
        if (filasPendientes === 0) {
          // Un subtotal sin tickets propios es el total general del archivo
          totalGeneral = subtotal;
        } else {
          let nombre = seccion ?? SIN_SECCION;
          if (grupos.some((g) => g.nombre === nombre)) nombre = `${nombre} (fila ${fila})`;
          grupos.push({ nombre, tickets: pendientes, subtotal });
          pendientes = [];
          filasPendientes = 0;
        }
        break;
      }
      case 'desconocida':
        incidencias.push({
          severidad: 'ERROR',
          regla: 'FILA_DESCONOCIDA',
          fila,
          valor: tipo.contenido,
          mensaje: `La fila ${fila} no es ticket, sección ni subtotal (${tipo.contenido}). ¿Cambió el formato del reporte?`,
        });
        break;
    }
  }
  cerrarSinSubtotal('el archivo termina');

  if (faltaEstacion) {
    incidencias.push({
      severidad: 'ERROR',
      regla: 'ESTACION_FALTA',
      columna: 'estacion',
      mensaje:
        'Hay tickets con la columna Estación vacía. Indica la estación con --estacion o con ETL_ESTACION_POR_DEFECTO en el .env',
    });
  }
  if (tickets.length === 0 && !incidencias.some((i) => i.severidad === 'ERROR')) {
    incidencias.push({ severidad: 'ERROR', regla: 'SIN_TICKETS', mensaje: 'El archivo no trae ningún ticket' });
  }

  // Tickets repetidos dentro del archivo
  const vistos = new Map<string, number>();
  for (const t of tickets) {
    const clave = `${codigoEstacion(t.estacion)}-${t.ticket}`;
    const previa = vistos.get(clave);
    if (previa !== undefined) {
      incidencias.push({
        severidad: 'ERROR',
        regla: 'TICKET_REPETIDO',
        fila: t.fila,
        ticket: t.ticket,
        mensaje: `El ticket ${t.ticket} viene dos veces (filas ${previa} y ${t.fila})`,
      });
    } else {
      vistos.set(clave, t.fila);
    }
  }

  incidencias.push(...aplicarReglas(tickets));
  const cuadre = cuadrar(grupos, totalGeneral, tickets);
  incidencias.push(...cuadre.incidencias);

  let total = new Decimal(0);
  let cantidad = new Decimal(0);
  for (const t of tickets) {
    if (t.total) total = total.plus(t.total);
    if (t.cantidad) cantidad = cantidad.plus(t.cantidad);
  }
  const turnos = tickets.map((t) => t.turno);
  const fechas = tickets.map((t) => t.fecha_hora).sort();

  return {
    ...vacio,
    tickets,
    grupos,
    totalGeneral,
    cuadre: cuadre.filas,
    incidencias,
    resumen: {
      estaciones: [...new Set(tickets.map((t) => codigoEstacion(t.estacion)))],
      turnoMin: turnos.length ? Math.min(...turnos) : null,
      turnoMax: turnos.length ? Math.max(...turnos) : null,
      fechaMin: fechas[0] ?? null,
      fechaMax: fechas[fechas.length - 1] ?? null,
      total: total.toFixed(2),
      cantidad: cantidad.toFixed(),
    },
  };
}

export async function leerReporte(ruta: string, opciones: OpcionesLectura = {}): Promise<ResultadoLectura> {
  return procesarHojas(await abrirExcel(ruta), opciones);
}
