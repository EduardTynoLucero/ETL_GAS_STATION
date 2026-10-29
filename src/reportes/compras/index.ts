// Lectura completa del "Reporte de compras": encabezado, filas, conversión, reglas y cuadre.
// Tiene la misma forma que la Consulta de Tickets: una sección por producto, sus líneas, un
// subtotal por sección y el total general. No toca la base de datos.
import { Decimal } from 'decimal.js';
import type { Hoja, ValorCelda } from '../../lector/excel.js';
import { aDecimal, aEntero, aFechaHora, aTexto, decimalesImpresos, estaVacia, normalizar, ValorInvalido } from '../consulta-tickets/conversion.js';
import { codigoEstacion } from '../consulta-tickets/reglas.js';
import type { Incidencia } from '../consulta-tickets/tipos.js';
import { leerEncabezadoCompras, type EncabezadoCompras } from './encabezado.js';
import {
  COMBUSTIBLES,
  ESCALAS_COMPRA,
  MEDIDAS_CUADRE_COMPRA,
  type CampoCompra,
  type CampoNumeroCompra,
  type Compra,
  type FilaCuadreCompra,
  type MedidaCuadreCompra,
  type ResultadoCompras,
} from './tipos.js';

export interface OpcionesLecturaCompras {
  /** El reporte de compras no trae la estación: "PCONC - GASOLINERA CONCEPCION LAS MINAS" */
  estacion?: string;
}

const SIN_SECCION = '(sin sección)';
const TOLERANCIA_TOTAL = new Decimal('0.02');
const TOLERANCIA_FOB = new Decimal('0.01');
// Un subtotal guardado como número (no como texto) puede traer ruido de punto flotante en el último decimal
const TOLERANCIA_MINIMA_NUMERO = new Decimal('0.0001');

type Subtotal = { fila: number; valores: Partial<Record<MedidaCuadreCompra, { valor: Decimal; tolerancia: Decimal }>> };

export const esCombustible = (producto: string) => COMBUSTIBLES.includes(producto.trim().toUpperCase());

/** "Sí", "S", "X", "1" o "Anulada" marcan la línea como anulada; vacío, "No" o "0", no */
function aAnulada(v: ValorCelda): boolean {
  if (typeof v === 'boolean') return v;
  const t = normalizar(v);
  return t !== '' && !['no', 'n', '0', 'false', 'falso'].includes(t);
}

type TipoFila = 'vacia' | 'seccion' | 'compra' | 'subtotal' | 'desconocida';

function clasificarFila(hoja: Hoja, enc: EncabezadoCompras, fila: number): { tipo: TipoFila; nombre?: string; contenido?: string } {
  const llenas: { col: number; valor: ValorCelda }[] = [];
  for (let c = 1; c <= hoja.columnas; c++) {
    const v = hoja.valor(fila, c);
    if (!estaVacia(v)) llenas.push({ col: c, valor: v });
  }
  if (llenas.length === 0) return { tipo: 'vacia' };
  const celda = (campo: CampoCompra) => (enc.col[campo] ? hoja.valor(fila, enc.col[campo]!) : null);
  // Una línea de compra siempre trae número de factura y fecha
  if (!estaVacia(celda('numero')) && !estaVacia(celda('fecha_hora'))) return { tipo: 'compra' };
  const colsMedida = new Set(MEDIDAS_CUADRE_COMPRA.map((m) => enc.col[m]).filter((c): c is number => c !== undefined));
  const primera = llenas[0]!;
  if (llenas.length === 1 && typeof primera.valor === 'string' && !colsMedida.has(primera.col)) {
    return { tipo: 'seccion', nombre: primera.valor.trim() };
  }
  if (estaVacia(celda('numero')) && llenas.some((l) => colsMedida.has(l.col))) return { tipo: 'subtotal' };
  return {
    tipo: 'desconocida',
    contenido: llenas
      .slice(0, 4)
      .map((l) => aTexto(l.valor))
      .join(' | '),
  };
}

function leerSubtotal(hoja: Hoja, enc: EncabezadoCompras, fila: number, incidencias: Incidencia[]): Subtotal {
  const valores: Subtotal['valores'] = {};
  for (const medida of MEDIDAS_CUADRE_COMPRA) {
    const col = enc.col[medida];
    if (!col) continue;
    const v = hoja.valor(fila, col);
    if (estaVacia(v)) continue;
    try {
      let tolerancia = new Decimal(5).times(new Decimal(10).pow(-(decimalesImpresos(v) + 1)));
      if (typeof v === 'number') tolerancia = Decimal.max(tolerancia, TOLERANCIA_MINIMA_NUMERO);
      valores[medida] = { valor: aDecimal(v)!, tolerancia };
    } catch (err) {
      if (!(err instanceof ValorInvalido)) throw err;
      incidencias.push({
        severidad: 'ERROR',
        regla: 'SUBTOTAL_ILEGIBLE',
        fila,
        columna: medida,
        valor: String(v),
        mensaje: `El subtotal de ${medida} no se puede leer: ${err.message}`,
      });
    }
  }
  return { fila, valores };
}

function leerCompra(
  hoja: Hoja,
  enc: EncabezadoCompras,
  fila: number,
  seccion: string | null,
  estacion: string,
  incidencias: Incidencia[],
): Compra | null {
  const celda = (campo: CampoCompra): ValorCelda => (enc.col[campo] ? hoja.valor(fila, enc.col[campo]!) : null);
  let valido = true;
  const error = (regla: string, columna: string, valor: ValorCelda, mensaje: string) => {
    valido = false;
    incidencias.push({ severidad: 'ERROR', regla, fila, columna, valor: valor === null ? '' : String(valor), mensaje });
  };

  const serie = aTexto(celda('serie'))?.trim() ?? '';
  const numero = aTexto(celda('numero'))?.trim() ?? '';
  const factura = `${serie}-${numero}`;
  if (!serie) error('VALOR_OBLIGATORIO_FALTA', 'serie', null, `Fila ${fila}: falta la serie de la factura ${numero}`);

  let turno: number | null = null;
  try {
    turno = aEntero(celda('turno'));
  } catch (err) {
    if (!(err instanceof ValorInvalido)) throw err;
    error('NUMERO_INVALIDO', 'turno', celda('turno'), `Fila ${fila}, factura ${factura}, turno: ${err.message}`);
  }

  let fecha_hora = '';
  try {
    fecha_hora = aFechaHora(celda('fecha_hora'));
  } catch (err) {
    if (!(err instanceof ValorInvalido)) throw err;
    error('FECHA_INVALIDA', 'fecha_hora', celda('fecha_hora'), `Fila ${fila}, factura ${factura}: ${err.message}`);
  }

  const numeros = {} as Record<CampoNumeroCompra, Decimal | null>;
  for (const campo of Object.keys(ESCALAS_COMPRA) as CampoNumeroCompra[]) {
    const v = celda(campo);
    try {
      numeros[campo] = aDecimal(v);
    } catch (err) {
      if (!(err instanceof ValorInvalido)) throw err;
      error('NUMERO_INVALIDO', campo, v, `Fila ${fila}, factura ${factura}, ${campo}: ${err.message}`);
      numeros[campo] = null;
    }
  }
  const producto = aTexto(celda('producto'))?.trim() ?? '';
  if (!producto) error('VALOR_OBLIGATORIO_FALTA', 'producto', null, `Fila ${fila}, factura ${factura}: falta el producto`);
  for (const campo of ['cantidad', 'total'] as const) {
    if (numeros[campo] === null && valido) error('VALOR_OBLIGATORIO_FALTA', campo, null, `Fila ${fila}, factura ${factura}: falta ${campo}`);
  }
  if (!valido) return null;

  return {
    fila,
    seccion,
    estacion,
    turno,
    serie,
    numero,
    fecha_hora,
    proveedor_nit: aTexto(celda('proveedor_nit'))?.trim() || null,
    proveedor_nombre: aTexto(celda('proveedor_nombre'))?.trim() || null,
    producto,
    cantidad: numeros.cantidad!,
    precio: numeros.precio,
    total: numeros.total!,
    fob_total: numeros.fob_total,
    fob_unitario: numeros.fob_unitario,
    cif_total: numeros.cif_total,
    cif_unitario: numeros.cif_unitario,
    anulada: aAnulada(celda('anulada')),
    combustible: aTexto(celda('combustible'))?.trim() || null,
    f1: numeros.f1,
    f2: numeros.f2,
    f3: numeros.f3,
  };
}

/** Reglas de calidad sobre las líneas ya convertidas. Ninguna detiene la carga */
function aplicarReglas(compras: Compra[]): Incidencia[] {
  const r: Incidencia[] = [];
  for (const c of compras) {
    const factura = `${c.serie}-${c.numero}`;
    const base = { fila: c.fila, valor: factura };
    const producto = c.producto.toUpperCase();
    if (c.anulada) {
      r.push({ ...base, severidad: 'INFO', regla: 'COMPRA_ANULADA', mensaje: `La compra ${factura} de ${producto} viene anulada: se guarda, pero no suma al inventario` });
    }
    if (!c.cantidad.gt(0)) {
      r.push({ ...base, severidad: 'ADVERTENCIA', regla: 'CANTIDAD_NO_POSITIVA', columna: 'cantidad', mensaje: `La compra ${factura} de ${producto} trae cantidad ${c.cantidad.toFixed()}` });
    }
    if (!esCombustible(producto)) {
      r.push({ ...base, severidad: 'INFO', regla: 'NO_ES_COMBUSTIBLE', mensaje: `${producto} (${factura}) no es combustible: se guarda con las compras, pero no entra al inventario de galones` });
    }
    if (c.seccion && normalizar(c.seccion) !== normalizar(producto)) {
      r.push({ ...base, severidad: 'ADVERTENCIA', regla: 'PRODUCTO_DISTINTO_A_SECCION', mensaje: `La compra ${factura} es de ${producto} pero está en la sección ${c.seccion}` });
    }
    if (c.precio && c.cantidad.times(c.precio).minus(c.total).abs().gt(TOLERANCIA_TOTAL)) {
      r.push({
        ...base,
        severidad: 'ADVERTENCIA',
        regla: 'FORMULA',
        columna: 'total',
        mensaje: `${factura} ${producto}: cantidad × precio da ${c.cantidad.times(c.precio).toDecimalPlaces(2).toFixed(2)} y el total dice ${c.total.toFixed(2)}`,
      });
    }
    if (c.fob_total && c.fob_unitario && c.fob_unitario.times(c.cantidad).minus(c.fob_total).abs().gt(TOLERANCIA_FOB)) {
      r.push({
        ...base,
        severidad: 'ADVERTENCIA',
        regla: 'FORMULA',
        columna: 'fob_total',
        mensaje: `${factura} ${producto}: FOB unitario × cantidad da ${c.fob_unitario.times(c.cantidad).toDecimalPlaces(4).toFixed()} y el costo FOB dice ${c.fob_total.toFixed()}`,
      });
    }
    // En las compras de combustible el FOB es el total sin IVA ni IDP; si son iguales, el costo quedó con impuestos
    if (esCombustible(producto) && c.fob_total && c.total.gt(0) && c.fob_total.minus(c.total).abs().lte(TOLERANCIA_FOB)) {
      r.push({
        ...base,
        severidad: 'INFO',
        regla: 'FOB_IGUAL_AL_TOTAL',
        columna: 'fob_total',
        mensaje: `${factura} ${producto}: el costo FOB (Q${c.fob_total.toFixed(2)}) es igual al total facturado; parece que no se le restaron el IVA ni el IDP`,
      });
    }
  }
  return r;
}

function cuadrar(grupos: { nombre: string; compras: Compra[]; subtotal: Subtotal }[], totalGeneral: Subtotal | null, todas: Compra[]) {
  const filas: FilaCuadreCompra[] = [];
  const comparar = (nombre: string, compras: Compra[], subtotal: Subtotal) => {
    for (const medida of MEDIDAS_CUADRE_COMPRA) {
      const impreso = subtotal.valores[medida];
      if (!impreso) continue;
      let suma = new Decimal(0);
      for (const c of compras) if (c[medida]) suma = suma.plus(c[medida]!);
      filas.push({
        grupo: nombre,
        medida,
        tickets: compras.length,
        sumaDetalle: suma,
        valorReporte: impreso.valor,
        tolerancia: impreso.tolerancia,
        cuadra: suma.minus(impreso.valor).abs().lte(impreso.tolerancia),
      });
    }
  };
  for (const g of grupos) comparar(g.nombre, g.compras, g.subtotal);
  if (totalGeneral) comparar('TOTAL GENERAL', todas, totalGeneral);

  const incidencias: Incidencia[] = filas
    .filter((f) => !f.cuadra)
    .map((f) => ({
      severidad: 'ERROR' as const,
      regla: 'NO_CUADRA',
      columna: f.medida,
      valor: f.sumaDetalle.toFixed(),
      mensaje:
        `${f.grupo}: la suma de ${f.medida} de las ${f.tickets} líneas da ${f.sumaDetalle.toFixed()} ` +
        `y el reporte dice ${f.valorReporte.toFixed()} (diferencia ${f.sumaDetalle.minus(f.valorReporte).toFixed()})`,
    }));
  if (!totalGeneral) {
    incidencias.push({ severidad: 'ADVERTENCIA', regla: 'TOTAL_NO_ENCONTRADO', mensaje: 'El archivo no trae la fila de total general; solo se cuadró contra los subtotales' });
  }
  return { filas, incidencias };
}

/** Procesa las hojas ya abiertas del Reporte de compras */
export function procesarCompras(hojas: Hoja[], opciones: OpcionesLecturaCompras = {}): ResultadoCompras {
  const { encabezado: enc, incidencias } = leerEncabezadoCompras(hojas);
  const estacion = opciones.estacion?.trim() ?? '';
  const vacio: ResultadoCompras = {
    hoja: enc?.hoja.nombre ?? hojas[0]?.nombre ?? '',
    filaEncabezado: enc?.filaEncabezado ?? 0,
    columnas: enc?.columnas ?? [],
    compras: [],
    cuadre: [],
    incidencias,
    resumen: { estaciones: [], proveedores: [], turnoMin: null, turnoMax: null, fechaMin: null, fechaMax: null, total: '0', galones: '0' },
  };
  if (!enc || incidencias.some((i) => i.severidad === 'ERROR')) return vacio;
  if (!estacion) {
    incidencias.push({
      severidad: 'ERROR',
      regla: 'ESTACION_FALTA',
      columna: 'estacion',
      mensaje:
        'El Reporte de compras no trae la estación. Indícala con la opción Estación del panel, con --estacion "PCONC - GASOLINERA CONCEPCION LAS MINAS" ' +
        'o con ETL_ESTACION_POR_DEFECTO en el .env',
    });
    return vacio;
  }

  const { hoja } = enc;
  const compras: Compra[] = [];
  const grupos: { nombre: string; compras: Compra[]; subtotal: Subtotal }[] = [];
  let totalGeneral: Subtotal | null = null;
  let seccion: string | null = null;
  let pendientes: Compra[] = [];
  let filasPendientes = 0;

  const cerrarSinSubtotal = (motivo: string) => {
    if (filasPendientes === 0) return;
    incidencias.push({
      severidad: 'ERROR',
      regla: 'GRUPO_SIN_SUBTOTAL',
      mensaje: `${filasPendientes} líneas de ${seccion ?? SIN_SECCION} no tienen fila de subtotal (${motivo}). ¿El archivo está incompleto?`,
    });
    pendientes = [];
    filasPendientes = 0;
  };

  for (let fila = enc.filaInicioDatos; fila <= hoja.filas; fila++) {
    const t = clasificarFila(hoja, enc, fila);
    if (t.tipo === 'vacia') continue;
    if (t.tipo === 'seccion') {
      cerrarSinSubtotal(`empieza la sección ${t.nombre} en la fila ${fila}`);
      seccion = t.nombre!;
    } else if (t.tipo === 'compra') {
      filasPendientes++;
      const c = leerCompra(hoja, enc, fila, seccion, estacion, incidencias);
      if (c) {
        compras.push(c);
        pendientes.push(c);
      }
    } else if (t.tipo === 'subtotal') {
      const subtotal = leerSubtotal(hoja, enc, fila, incidencias);
      // Un subtotal sin líneas propias es el total general del archivo
      if (filasPendientes === 0) totalGeneral = subtotal;
      else {
        let nombre = seccion ?? SIN_SECCION;
        if (grupos.some((g) => g.nombre === nombre)) nombre = `${nombre} (fila ${fila})`;
        grupos.push({ nombre, compras: pendientes, subtotal });
        pendientes = [];
        filasPendientes = 0;
      }
    } else {
      incidencias.push({
        severidad: 'ERROR',
        regla: 'FILA_DESCONOCIDA',
        fila,
        valor: t.contenido,
        mensaje: `La fila ${fila} no es compra, sección ni subtotal (${t.contenido}). ¿Cambió el formato del reporte?`,
      });
    }
  }
  cerrarSinSubtotal('el archivo termina');

  if (compras.length === 0 && !incidencias.some((i) => i.severidad === 'ERROR')) {
    incidencias.push({ severidad: 'ERROR', regla: 'SIN_COMPRAS', mensaje: 'El archivo no trae ninguna compra' });
  }

  // La misma factura y producto dos veces
  const vistas = new Map<string, number>();
  for (const c of compras) {
    const clave = `${c.serie}|${c.numero}|${c.producto.toUpperCase()}`;
    const previa = vistas.get(clave);
    if (previa !== undefined) {
      incidencias.push({
        severidad: 'ERROR',
        regla: 'COMPRA_REPETIDA',
        fila: c.fila,
        valor: `${c.serie}-${c.numero}`,
        mensaje: `La factura ${c.serie}-${c.numero} de ${c.producto} viene dos veces (filas ${previa} y ${c.fila})`,
      });
    } else {
      vistas.set(clave, c.fila);
    }
  }

  incidencias.push(...aplicarReglas(compras));
  const cuadre = cuadrar(grupos, totalGeneral, compras);
  incidencias.push(...cuadre.incidencias);

  let total = new Decimal(0);
  let galones = new Decimal(0);
  for (const c of compras) {
    total = total.plus(c.total);
    if (esCombustible(c.producto) && !c.anulada) galones = galones.plus(c.cantidad);
  }
  const turnos = compras.map((c) => c.turno).filter((t): t is number => t !== null);
  const fechas = compras.map((c) => c.fecha_hora).sort();
  return {
    ...vacio,
    compras,
    cuadre: cuadre.filas,
    incidencias,
    resumen: {
      estaciones: [...new Set(compras.map((c) => codigoEstacion(c.estacion)))],
      proveedores: [...new Set(compras.map((c) => c.proveedor_nombre).filter((p): p is string => Boolean(p)))],
      turnoMin: turnos.length ? Math.min(...turnos) : null,
      turnoMax: turnos.length ? Math.max(...turnos) : null,
      fechaMin: fechas[0] ?? null,
      fechaMax: fechas[fechas.length - 1] ?? null,
      total: total.toFixed(2),
      galones: galones.toFixed(),
    },
  };
}
