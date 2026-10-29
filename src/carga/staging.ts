// Copia los tickets leídos a stg.ticket_despacho con COPY (carga masiva, mucho más rápida que INSERT)
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import copyStreams from 'pg-copy-streams';
import type { Cliente } from '../db.js';
import { decimalATexto } from '../reportes/consulta-tickets/conversion.js';
import { ESCALAS, type CampoNumero, type Ticket } from '../reportes/consulta-tickets/tipos.js';

const COLUMNAS = [
  'carga_id', 'fila_excel', 'seccion', 'estacion', 'turno', 'ticket', 'bomba', 'servicio', 'credito',
  'factura_serie', 'factura_numero', 'fecha_hora', 'cliente_codigo', 'cliente_nit', 'cliente_nombre', 'vale',
  'producto', 'cantidad', 'precio_despacho', 'precio_lista', 'iva', 'idp', 'descuento', 'total', 'total_neto',
  'costo_total', 'costo_unitario', 'utilidad', 'utilidad_pct', 'utilidad_unitario', 'pricebook', 'plan_fidelidad',
] as const;

/** Texto entre comillas para CSV; null queda sin comillas, que COPY lee como NULL */
const texto = (v: string | null) => (v === null ? '' : `"${v.replace(/"/g, '""')}"`);

function filaCsv(cargaId: number, t: Ticket): string {
  const num = (campo: CampoNumero) => {
    const v = t[campo];
    return v === null ? '' : decimalATexto(v, ESCALAS[campo]);
  };
  const valores: Record<(typeof COLUMNAS)[number], string> = {
    carga_id: String(cargaId),
    fila_excel: String(t.fila),
    seccion: texto(t.seccion),
    estacion: texto(t.estacion),
    turno: String(t.turno),
    ticket: String(t.ticket),
    bomba: t.bomba === null ? '' : String(t.bomba),
    servicio: texto(t.servicio),
    credito: texto(t.credito),
    factura_serie: texto(t.factura_serie),
    factura_numero: texto(t.factura_numero),
    fecha_hora: t.fecha_hora,
    cliente_codigo: texto(t.cliente_codigo),
    cliente_nit: texto(t.cliente_nit),
    cliente_nombre: texto(t.cliente_nombre),
    vale: texto(t.vale),
    producto: texto(t.producto),
    cantidad: num('cantidad'),
    precio_despacho: num('precio_despacho'),
    precio_lista: num('precio_lista'),
    iva: num('iva'),
    idp: num('idp'),
    descuento: num('descuento'),
    total: num('total'),
    total_neto: num('total_neto'),
    costo_total: num('costo_total'),
    costo_unitario: num('costo_unitario'),
    utilidad: num('utilidad'),
    utilidad_pct: num('utilidad_pct'),
    utilidad_unitario: num('utilidad_unitario'),
    pricebook: texto(t.pricebook),
    plan_fidelidad: texto(t.plan_fidelidad),
  };
  return COLUMNAS.map((c) => valores[c]).join(',') + '\n';
}

export async function copiarAStaging(c: Cliente, cargaId: number, tickets: Ticket[]): Promise<number> {
  const destino = c.query(
    copyStreams.from(`COPY stg.ticket_despacho (${COLUMNAS.join(', ')}) FROM STDIN WITH (FORMAT csv)`),
  );
  async function* filas() {
    for (const t of tickets) yield filaCsv(cargaId, t);
  }
  await pipeline(Readable.from(filas()), destino);
  return destino.rowCount ?? tickets.length;
}
