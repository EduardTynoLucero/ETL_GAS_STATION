// Pestaña "Cargar reporte": subir el archivo, revisar lo que trae y lo que cambiaría en la base, y cargarlo.
// El mismo lugar sirve para la Consulta de Tickets y el Reporte de compras: el servidor reconoce cuál es por sus
// columnas (previa.tipo) y aquí cambia lo que se muestra; la carga corre el ETL de cada uno.
import { avisar, bus, conexion, pedir, preferencia, revisarConexion } from './estado.js';
import {
  barrasApiladas,
  barrasHorizontales,
  colorProducto,
  conectarSegmentado,
  conPunto,
  ordenarProductos,
  pivotar,
  segmentado,
  tablaHtml,
  tarjeta,
  varProducto,
} from './graficas.js';
import { diaSemana, escapar, estado, estadoLargo, fecha, fechaHora, fmt, ICONOS, insignia, momento, nombreRegla, plural, SEVERIDAD } from './util.js';

const MAX_MB = 50; // el mismo límite que el servidor

let raiz;
let previaEl;
let archivoActual = null;
let previa = null;
let comparacion = null; // {ok: true, datos} | {ok: false, error, tipo, estado} | null mientras se compara
let cargando = false;
let resultado = null;
let errorCarga = null; // por qué falló "Cargar a la base" (se muestra hasta el siguiente intento)
let pedidoPrevia = 0; // cada archivo (o estación) revisado es una petición nueva: una respuesta vieja se ignora
let pedidoComparacion = 0;
let reintentoPedido = false; // se presionó "Reintentar" y se espera la revisión de la conexión
let estabaConectado = false;
let rechazadoAlCargar = null; // archivo que se soltó o eligió mientras se cargaba otro (no se revisó)
const tabla = { pagina: 1, porPagina: 25, filtro: 'todos', buscar: '', producto: '' };

export function iniciar(contenedor) {
  raiz = contenedor;
  raiz.innerHTML = `
    <section class="tarjeta">
      <div class="tarjeta-cabeza">
        <div>
          <h2>Sube el reporte</h2>
          <p class="tarjeta-sub">La Consulta de Tickets (ventas) o el Reporte de compras, exportados de BISS en Excel (.xlsx). El panel reconoce cuál es por sus columnas. Primero se revisa aquí; nada entra a la base hasta que presiones "Cargar a la base".</p>
        </div>
      </div>
      <div class="zona" id="zona" role="button" tabindex="0" aria-describedby="zona-ayuda">
        ${ICONOS.subir}
        <strong>Arrastra aquí el archivo .xlsx</strong>
        <p id="zona-ayuda">o haz clic para buscarlo en tu PC</p>
      </div>
      <p id="zona-aviso" role="status" style="overflow-wrap:anywhere"></p>
      <input type="file" id="archivo" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden />
      <div class="carga-opciones">
        <label class="campo">Tu nombre (queda en el historial de cargas)
          <input type="text" id="usuario" maxlength="60" autocomplete="name" />
        </label>
        <label class="campo">Estación (para el Reporte de compras y las exportaciones sin la columna Estación)
          <input type="text" id="estacion" maxlength="80" />
        </label>
      </div>
    </section>
    <div id="previa" class="pila"></div>`;
  previaEl = raiz.querySelector('#previa');

  const zona = raiz.querySelector('#zona');
  const entrada = raiz.querySelector('#archivo');
  zona.addEventListener('click', abrirSelector);
  zona.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      abrirSelector();
    }
  });
  entrada.addEventListener('change', () => {
    if (entrada.files?.[0]) revisarArchivo(entrada.files[0]);
    entrada.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    zona.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!cargando) zona.classList.add('encima');
    });
  }
  for (const ev of ['dragleave', 'drop']) zona.addEventListener(ev, () => zona.classList.remove('encima'));
  zona.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) revisarArchivo(f);
  });
  // Soltar el archivo fuera de la zona no debe hacer que el navegador lo abra
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  const usuario = raiz.querySelector('#usuario');
  usuario.value = preferencia.leer('usuario', '');
  usuario.addEventListener('change', () => preferencia.guardar('usuario', usuario.value.trim()));

  const estacion = raiz.querySelector('#estacion');
  estacion.value = preferencia.leer('estacion', '');
  estacion.addEventListener('change', () => {
    preferencia.guardar('estacion', estacion.value.trim());
    // Con otra estación, el mismo archivo se revisa de nuevo
    if (archivoActual && !cargando && !resultado) revisarArchivo(archivoActual);
  });

  // La pestaña puede abrirse después de la primera revisión de la conexión
  estabaConectado = conexion.conectado;
  bus.addEventListener('conexion', () => {
    const d = conexion.datos;
    usuario.placeholder = d?.config?.usuarioEtl ? `Si lo dejas vacío: ${d.config.usuarioEtl}` : '';
    estacion.placeholder = d?.config?.estacionPorDefecto ? `Por defecto: ${d.config.estacionPorDefecto}` : 'Ejemplo: PCONC - GASOLINERA CONCEPCION LAS MINAS';
    if (conexion.revisando) return; // se decide con el resultado de la revisión, no con el valor anterior
    const volvio = conexion.conectado && !estabaConectado;
    const pedido = reintentoPedido;
    estabaConectado = conexion.conectado;
    reintentoPedido = false;
    if (!previa || resultado || !comparacion || comparacion.ok) return;
    // La comparación había fallado: se intenta otra vez si la base volvió o si se presionó "Reintentar".
    // Una comparación que falla con la base conectada no se repite sola (si no, sería un ciclo sin fin).
    if (conexion.conectado && (volvio || pedido) && comparacion.estado !== 404) comparar();
    else if (pedido) pintarComparacion();
  });
}

// ---------------------------------------------------------------------------------------------

/** Abre el selector de archivos, salvo mientras se carga (ahí solo se avisa) */
function abrirSelector() {
  if (cargando) avisarOcupado();
  else raiz.querySelector('#archivo').click();
}

/** Aviso breve debajo de la zona (html ya escapado; vacío lo quita) */
function avisoZona(contenido) {
  const p = raiz.querySelector('#zona-aviso');
  p.innerHTML = contenido;
  p.style.marginTop = contenido ? '10px' : '';
}

/** Mientras se carga, la zona queda desactivada y dice por qué */
function pintarZona() {
  const zona = raiz.querySelector('#zona');
  zona.classList.remove('encima');
  if (cargando) {
    zona.setAttribute('aria-disabled', 'true');
    zona.querySelector('strong').textContent = 'Cargando a la base…';
    zona.querySelector('#zona-ayuda').textContent = 'Espera a que termine para revisar otro archivo.';
    return;
  }
  zona.removeAttribute('aria-disabled');
  zona.querySelector('strong').textContent = 'Arrastra aquí el archivo .xlsx';
  zona.querySelector('#zona-ayuda').textContent = 'o haz clic para buscarlo en tu PC';
  // Si se soltó otro archivo durante la carga, se recuerda que falta revisarlo
  avisoZona(rechazadoAlCargar ? estadoLargo('info', `La carga terminó: ya puedes revisar "${rechazadoAlCargar}".`) : '');
  rechazadoAlCargar = null;
}

/** Se soltó o eligió un archivo mientras se cargaba otro: no se revisa, pero se avisa */
function avisarOcupado(nombre) {
  const actual = archivoActual?.name ?? 'el archivo actual';
  if (nombre) rechazadoAlCargar = nombre;
  avisoZona(
    estadoLargo(
      'aviso',
      nombre
        ? `"${nombre}" no se revisó: espera a que termine la carga de ${actual} y vuelve a elegirlo.`
        : `Espera a que termine la carga de ${actual} para revisar otro archivo.`,
    ),
  );
}

async function revisarArchivo(archivo) {
  if (cargando) {
    avisarOcupado(archivo.name);
    return;
  }
  avisoZona('');
  const yo = ++pedidoPrevia;
  archivoActual = archivo;
  previa = null;
  comparacion = null;
  resultado = null;
  errorCarga = null;
  reintentoPedido = false;
  Object.assign(tabla, { pagina: 1, filtro: 'todos', buscar: '', producto: '' });
  if (!/\.xlsx$/i.test(archivo.name)) {
    pintarError(`"${archivo.name}" no es un archivo .xlsx. Exporta la Consulta de Tickets o el Reporte de compras desde BISS en formato Excel.`);
    return;
  }
  // Uno más grande ni se sube: el servidor lo rechazaría igual
  if (archivo.size > MAX_MB * 1024 * 1024) {
    const mb = Math.ceil((archivo.size / 1024 / 1024) * 10) / 10;
    pintarError(`"${archivo.name}" pesa ${fmt.numero(mb, 1)} MB y el máximo es ${MAX_MB} MB. Revisa que sea la Consulta de Tickets o el Reporte de compras exportado de BISS y no otro archivo.`);
    return;
  }
  previaEl.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Revisando ${escapar(archivo.name)} (${fmt.numero(archivo.size / 1024 / 1024, 1)} MB)…</div>`;
  const estacion = raiz.querySelector('#estacion').value.trim();
  let p;
  try {
    p = await pedir(`/api/vista-previa${estacion ? `?estacion=${encodeURIComponent(estacion)}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Archivo-Nombre': encodeURIComponent(archivo.name) },
      body: archivo,
    });
  } catch (err) {
    if (yo === pedidoPrevia) pintarError(err.message);
    return;
  }
  if (yo !== pedidoPrevia) return; // mientras se revisaba llegó otro archivo, se cambió la estación o se canceló
  previa = p;
  pintarPrevia();
  if (previa.valido) comparar();
}

function pintarError(mensaje) {
  previaEl.innerHTML = `
    <div class="veredicto veredicto-critico">${ICONOS.critico}
      <div><h2>No se pudo revisar el archivo</h2><p>${escapar(mensaje)}</p></div>
    </div>`;
}

async function comparar() {
  if (!previa) return;
  const token = previa.token;
  const yo = ++pedidoComparacion;
  const vigente = () => yo === pedidoComparacion && previa?.token === token;
  comparacion = null;
  pintarVeredicto();
  pintarComparacion();
  pintarAccion();
  try {
    const datos = await pedir(`/api/vista-previa/${token}/comparar`);
    if (!vigente()) return;
    comparacion = { ok: true, datos };
  } catch (err) {
    if (!vigente()) return;
    comparacion = { ok: false, error: err.message, tipo: err.tipo, estado: err.estado };
    // Así la insignia y el aviso de conexión muestran que la base no responde
    if (err.tipo === 'conexion') revisarConexion();
    if (err.estado === 404) cerrarTablaTickets(NOTA_VENCIDA);
  }
  pintarComparacion();
  pintarVeredicto();
  pintarAccion();
  actualizarFiltrosComparacion();
  // La tabla ya se leyó sin la base; con la comparación se vuelve a pedir para llenar "En la base"
  if (comparacion.ok) {
    if (esCompras()) pintarTablaCompras();
    else cargarTickets();
  }
}

// ---------------------------------------------------------------------------------------------
// Tickets o compras: lo que cambia en los textos

const esCompras = () => previa?.tipo === 'COMPRAS';
/** Cuántas filas trae el archivo: tickets, o líneas del reporte de compras */
const filasLeidas = () => (esCompras() ? previa.resumen.lineas : previa.resumen.tickets);
const filas = (n) => (esCompras() ? plural(n, 'compra', 'compras') : plural(n, 'ticket', 'tickets'));

/** Textos para cuando no se pudo comparar: la vista previa venció, no hay conexión u otro error */
function falloComparacion() {
  const c = comparacion;
  if (c.estado === 404) {
    return {
      vencida: true,
      titulo: 'El archivo está bien, pero la vista previa venció',
      corto: 'La vista previa venció',
      texto: 'El panel guarda cada archivo 30 minutos y lo olvida si se reinicia. Vuelve a subir el archivo para compararlo con la base y cargarlo.',
      accion: 'La vista previa venció: vuelve a subir el archivo.',
    };
  }
  if (c.tipo === 'conexion') {
    return {
      titulo: 'El archivo está bien, pero no hay conexión con la base',
      corto: 'No hay conexión con la base',
      texto: `${c.error} La vista previa no necesita la base: puedes revisar el archivo igual. Cuando la base responda, presiona "Reintentar" en "Qué pasará en la base".`,
      accion: 'No hay conexión con la base: cuando vuelva, presiona "Reintentar" en "Qué pasará en la base".',
    };
  }
  return {
    titulo: 'El archivo está bien, pero no se pudo comparar con la base',
    corto: 'No se pudo comparar con la base',
    texto: `${c.error} Presiona "Reintentar" en "Qué pasará en la base".`,
    accion: 'No se pudo comparar con la base: presiona "Reintentar" en "Qué pasará en la base".',
  };
}

/** Botón que abre el selector de archivos (para subir otra vez uno cuya vista previa venció) */
const botonElegirArchivo = '<button type="button" class="boton boton-chico" data-elegir-archivo>Elegir el archivo otra vez</button>';
function conectarElegirArchivo(cont) {
  cont.querySelector('[data-elegir-archivo]')?.addEventListener('click', abrirSelector);
}

const NOTA_VENCIDA = 'La vista previa venció: los filtros, la búsqueda y las páginas ya no funcionan. Vuelve a subir el archivo para revisarlo y cargarlo.';

/** El servidor ya no guarda la vista previa: se cargó o venció */
const previaCerrada = () => resultado?.estado === 'CARGADO' || errorCarga?.estado === 404 || comparacion?.estado === 404;

// ---------------------------------------------------------------------------------------------
// Vista previa

function pintarPrevia() {
  if (esCompras()) {
    pintarPreviaCompras();
    return;
  }
  const p = previa;
  const r = p.resumen;
  // Sin columna Estación, de dónde salió la que se usó: lo que se escribió en la opción o el .env
  // (sin tickets leídos no se usó ninguna)
  const origenEstacion =
    p.traeEstacion || !r.estaciones.length
      ? ''
      : p.estacionOrigen === 'opcion'
        ? 'tomada de la opción Estación'
        : p.estacionOrigen === 'env'
          ? 'tomada del .env (ETL_ESTACION_POR_DEFECTO)'
          : '';
  // Sin encabezado no hay hoja ni columnas que contar (no es el reporte)
  const encabezado = p.filaEncabezado
    ? `hoja "${escapar(p.hoja)}", encabezado en la fila ${p.filaEncabezado}, ${plural(p.columnas.length, 'columna', 'columnas')}${p.traeEstacion ? '' : ' (sin columna Estación)'}`
    : 'no se encontró el encabezado del reporte';
  previaEl.innerHTML = `
    <div id="veredicto"></div>
    <section class="tarjeta">
      <div class="tarjeta-cabeza"><div><h3>Qué trae el archivo</h3>
        <p class="tarjeta-sub">${escapar(p.archivo)} · ${fmt.numero(p.bytes / 1024 / 1024, 1)} MB · ${encabezado}</p>
      </div></div>
      <dl class="datos">
        ${dato('Tickets', fmt.entero(r.tickets))}
        ${dato('Venta total', fmt.moneda(Number(r.total)), `${fmt.galones(Number(r.cantidad))}`)}
        ${dato('Periodo', r.fechaMin ? `${fecha(r.fechaMin)} al ${fecha(r.fechaMax, true)}` : '–', r.fechaMin ? `${fechaHora(r.fechaMin, false)} a ${fechaHora(r.fechaMax, false)}` : '')}
        ${dato('Turnos', r.turnoMin ? `${r.turnoMin} al ${r.turnoMax}` : '–', r.turnoMin ? plural(r.turnoMax - r.turnoMin + 1, 'turno', 'turnos') : '')}
        ${dato('Estación', r.estaciones.join(', ') || '–', origenEstacion)}
        ${dato('Sin factura', fmt.moneda(p.agregados.sinFactura.total), `${plural(p.agregados.sinFactura.tickets, 'ticket', 'tickets')} · ${fmt.pct(pct(p.agregados.sinFactura.total, p.agregados.total.total))} de la venta`)}
      </dl>
    </section>
    <section class="tarjeta" id="comparacion"></section>
    <div class="rejilla" id="graficas-previa"></div>
    <div class="rejilla">
      <section class="tarjeta col-6" id="cuadre"></section>
      <section class="tarjeta col-6" id="incidencias"></section>
    </div>
    <section class="tarjeta" id="tickets"></section>
    <div id="accion"></div>`;
  pintarVeredicto();
  pintarComparacion();
  pintarGraficasPrevia();
  pintarCuadre();
  pintarIncidencias();
  pintarTablaTickets();
  pintarAccion();
  // La tabla sale de la vista previa, que no necesita la base: se lee sin esperar la comparación
  cargarTickets();
}

// ---------------------------------------------------------------------------------------------
// Vista previa del Reporte de compras: pocas líneas, todas en una tabla (sin páginas ni filtros)

function pintarPreviaCompras() {
  const p = previa;
  const r = p.resumen;
  const origenEstacion = !r.estaciones.length
    ? ''
    : p.estacionOrigen === 'opcion'
      ? 'tomada de la opción Estación'
      : p.estacionOrigen === 'env'
        ? 'tomada del .env (ETL_ESTACION_POR_DEFECTO)'
        : '';
  const encabezado = p.filaEncabezado
    ? `hoja "${escapar(p.hoja)}", encabezado en la fila ${p.filaEncabezado}, ${plural(p.columnas.length, 'columna', 'columnas')}`
    : 'no se encontró el encabezado del reporte';
  const combustibles = p.productos.filter((x) => x.combustible);
  const facturas = new Set(p.compras.map((c) => c.factura)).size;
  previaEl.innerHTML = `
    <div id="veredicto"></div>
    <section class="tarjeta">
      <div class="tarjeta-cabeza"><div><h3>Qué trae el archivo: Reporte de compras</h3>
        <p class="tarjeta-sub">${escapar(p.archivo)} · ${fmt.numero(p.bytes / 1024 / 1024, 1)} MB · ${encabezado}</p>
      </div></div>
      <dl class="datos">
        ${dato('Compras', fmt.entero(r.lineas), facturas ? plural(facturas, 'factura', 'facturas') : '')}
        ${dato('Galones de combustible', fmt.galones(Number(r.galones)), combustibles.map((x) => `${x.producto} ${fmt.numero(x.cantidad, 0)}`).join(' · '))}
        ${dato('Total facturado', fmt.moneda(Number(r.total)))}
        ${dato('Periodo', r.fechaMin ? `${fecha(r.fechaMin)} al ${fecha(r.fechaMax, true)}` : '–', r.fechaMin ? `${fechaHora(r.fechaMin, false)} a ${fechaHora(r.fechaMax, false)}` : '')}
        ${dato('Proveedor', r.proveedores.join(', ') || '–')}
        ${dato('Estación', r.estaciones.join(', ') || '–', origenEstacion)}
      </dl>
    </section>
    <section class="tarjeta" id="comparacion"></section>
    <div class="rejilla" id="graficas-previa"></div>
    <div class="rejilla">
      <section class="tarjeta col-6" id="cuadre"></section>
      <section class="tarjeta col-6" id="incidencias"></section>
    </div>
    <section class="tarjeta" id="tabla-compras"></section>
    <div id="accion"></div>`;
  pintarVeredicto();
  pintarComparacion();
  pintarProductosCompras();
  pintarCuadre();
  pintarIncidencias();
  pintarTablaCompras();
  pintarAccion();
}

function pintarProductosCompras() {
  const cont = previaEl.querySelector('#graficas-previa');
  const productos = previa.productos;
  if (!productos.length) {
    cont.hidden = true;
    return;
  }
  const combustibles = productos.filter((x) => x.combustible);
  const t = tarjeta({ titulo: 'Por producto', subtitulo: 'Galones de combustible comprados (sin las anuladas). Los lubricantes están en la tabla.', alto: 60 + 44 * Math.max(1, combustibles.length), clase: 'col-12' });
  barrasHorizontales(t.grafica, {
    categorias: combustibles.map((x) => x.producto),
    valores: combustibles.map((x) => x.cantidad),
    colorDe: (producto, _i, c) => colorProducto(producto, c),
    formato: fmt.galones,
    formatoEje: fmt.galonesCorto,
    nombreMedida: 'Galones',
    etiqueta: (i) => `${fmt.galones(combustibles[i].cantidad)} · ${fmt.moneda(combustibles[i].total)}`,
    nota: (i) => `${plural(combustibles[i].lineas, 'compra', 'compras')} · costo FOB ${fmt.porGalon(combustibles[i].costo / combustibles[i].cantidad)}`,
  });
  t.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Producto', valor: (x) => (x.combustible ? conPunto(x.producto, varProducto(x.producto)) : escapar(x.producto)), html: true },
        { titulo: 'Compras', valor: (x) => fmt.entero(x.lineas), der: true },
        { titulo: 'Cantidad', valor: (x) => `${fmt.numero(x.cantidad, 3)} ${x.combustible ? 'gal' : 'unid.'}`, der: true },
        { titulo: 'Total', valor: (x) => fmt.moneda(x.total), der: true },
        { titulo: 'Costo FOB', valor: (x) => fmt.moneda(x.costo), der: true },
        { titulo: 'Costo por unidad', valor: (x) => fmt.moneda(x.cantidad ? x.costo / x.cantidad : null), der: true },
      ],
      productos,
    ),
  );
  cont.append(t.el);
}

function pintarTablaCompras() {
  const cont = previaEl.querySelector('#tabla-compras');
  if (!cont) return;
  const cabeza = `<div class="tarjeta-cabeza"><div><h3>Compras del archivo</h3><p class="tarjeta-sub">Así entrarán al modelo: una fila por factura y producto. Para ver el detalle de una revisión o de un cambio, ábrelo con un clic, un toque o la tecla Enter.</p></div></div>`;
  if (!previa.compras.length) {
    cont.innerHTML = `${cabeza}<div class="vacio"><strong>Sin compras que mostrar</strong>No se pudo leer ninguna compra de este archivo. Arriba está el motivo.</div>`;
    return;
  }
  // "En la base" solo cuando ya se comparó línea por línea (no con un archivo repetido)
  const enLaBase = comparacion?.ok && !comparacion.datos.yaCargado ? new Map(comparacion.datos.porFila.map((x) => [x.fila, x])) : null;
  const producto = (c) =>
    `${c.combustible ? conPunto(c.producto, varProducto(c.producto)) : escapar(c.producto)}${c.anulada ? ` ${insignia('aviso', 'Anulada')}` : ''}`;
  cont.innerHTML = `${cabeza}${tablaHtml(
    [
      { titulo: 'Fecha y hora', valor: (c) => `<span class="nowrap">${escapar(fechaHora(c.fechaHora))}</span>`, html: true },
      { titulo: 'Factura', valor: (c) => c.factura },
      { titulo: 'Turno', valor: (c) => c.turno ?? '–', der: true },
      { titulo: 'Producto', valor: producto, html: true },
      { titulo: 'Cantidad', valor: (c) => fmt.numero(c.cantidad, 3), der: true },
      { titulo: 'Precio', valor: (c) => fmt.numero(c.precio, 4), der: true },
      { titulo: 'Total', valor: (c) => fmt.moneda(c.total), der: true },
      { titulo: 'Costo FOB', valor: (c) => fmt.moneda(c.costo), der: true },
      { titulo: 'Costo unitario', valor: (c) => fmt.numero(c.costoUnitario, 4), der: true },
      { titulo: 'Proveedor', valor: (c) => c.proveedor ?? '–' },
      ...(enLaBase ? [{ titulo: 'En la base', valor: (c) => enBase(enLaBase.get(c.fila)), html: true }] : []),
      { titulo: 'Revisión', valor: (c) => revision(c.incidencia), html: true },
    ],
    previa.compras,
  )}`;
}

const dato = (titulo, valor, nota = '') => `<div class="dato"><dt>${escapar(titulo)}</dt><dd class="num">${escapar(valor)}${nota ? `<small>${escapar(nota)}</small>` : ''}</dd></div>`;
const pct = (parte, total) => (total ? (100 * parte) / total : 0);

function pintarVeredicto() {
  const cont = previaEl.querySelector('#veredicto');
  if (!cont) return;
  const p = previa;
  const c = p.conteoIncidencias;
  const notaAvisos =
    c.ADVERTENCIA || c.INFO
      ? ` Trae ${plural(c.ADVERTENCIA, 'advertencia', 'advertencias')} y ${plural(c.INFO, 'nota informativa', 'notas informativas')}: no detienen la carga, pero vale la pena revisarlas.`
      : '';
  let clase;
  let icono;
  let titulo;
  let texto;
  let vencida = false;
  if (!p.valido) {
    clase = 'critico';
    icono = ICONOS.critico;
    titulo =
      filasLeidas() === 0 && c.ERROR === 0 ? `El archivo no trae ${esCompras() ? 'compras' : 'tickets'}` : `No se puede cargar: ${plural(c.ERROR, 'error', 'errores')}`;
    const estacionFalta = p.incidencias.some((i) => i.regla === 'ESTACION_FALTA');
    texto = estacionFalta
      ? `${esCompras() ? 'El Reporte de compras no trae la estación.' : 'Este archivo no trae la columna Estación.'} Escribe la estación en la opción "Estación" de arriba (por ejemplo: PCONC - GASOLINERA CONCEPCION LAS MINAS) y se revisa de nuevo.`
      : 'Corrige el archivo (o expórtalo otra vez desde BISS) y vuelve a subirlo. Abajo está el detalle de cada error.';
  } else if (errorCarga?.estado === 404) {
    // Se presionó "Cargar a la base" y el servidor ya no tenía la vista previa: arriba no puede seguir diciendo "Listo"
    vencida = true;
    clase = 'aviso';
    icono = ICONOS.aviso;
    titulo = 'El archivo está bien, pero la vista previa venció';
    texto = 'No se cargó nada. El panel guarda cada archivo 30 minutos y lo olvida si se reinicia: vuelve a subir el archivo para revisarlo y cargarlo.';
  } else if (!comparacion) {
    clase = 'info';
    icono = ICONOS.info;
    titulo = 'El archivo está bien. Comparando con lo que ya hay en la base…';
    texto = notaAvisos.trim();
  } else if (!comparacion.ok) {
    const f = falloComparacion();
    vencida = Boolean(f.vencida);
    clase = 'aviso';
    icono = ICONOS.aviso;
    titulo = f.titulo;
    texto = f.texto;
  } else if (comparacion.datos.yaCargado) {
    const y = comparacion.datos.yaCargado;
    clase = 'info';
    icono = ICONOS.info;
    titulo = 'Este archivo ya se cargó antes';
    texto = `Es el mismo archivo de la carga ${y.cargaId} (${y.archivo}, ${momento(y.cuando)}). Cargarlo otra vez no cambia nada: quedaría registrado como repetido.`;
  } else {
    const d = comparacion.datos;
    clase = 'bueno';
    icono = ICONOS.bueno;
    titulo = esCompras() ? 'Listo para cargar: Reporte de compras' : 'Listo para cargar';
    const nuevos = esCompras() ? plural(d.nuevos, 'compra nueva', 'compras nuevas') : plural(d.nuevos, 'ticket nuevo', 'tickets nuevos');
    texto = `${nuevos}, ${plural(d.cambian, 'se actualiza', 'se actualizan')} y ${plural(d.iguales, 'queda igual', 'quedan iguales')}. El cuadre contra los subtotales del reporte está bien.${notaAvisos}`;
  }
  const acciones = vencida ? `<div class="veredicto-acciones">${botonElegirArchivo}</div>` : '';
  cont.innerHTML = `<div class="veredicto veredicto-${clase}" role="status">${icono}<div style="min-width:0"><h2>${escapar(titulo)}</h2>${texto ? `<p>${escapar(texto)}</p>` : ''}</div>${acciones}</div>`;
  conectarElegirArchivo(cont);
}

function pintarComparacion() {
  const cont = previaEl.querySelector('#comparacion');
  if (!cont) return;
  const cabeza = `<div class="tarjeta-cabeza"><div><h3>Qué pasará en la base</h3><p class="tarjeta-sub">${
    esCompras()
      ? 'Cada compra se busca en el modelo por estación, serie y número de factura, y producto. Si ya existe, el último archivo cargado manda.'
      : 'Cada ticket se busca en el modelo por estación y número de ticket. Si un ticket ya existe, el último archivo cargado manda.'
  }</p></div></div>`;
  if (!previa.valido) {
    cont.innerHTML = `${cabeza}<p class="nota">No se compara porque el archivo tiene errores.</p>`;
    return;
  }
  if (!comparacion) {
    cont.innerHTML = `${cabeza}<div class="cargando"><span class="girador"></span>Comparando ${escapar(filas(filasLeidas()))} con la base…</div>`;
    return;
  }
  if (!comparacion.ok) {
    const f = falloComparacion();
    const boton = f.vencida
      ? botonElegirArchivo
      : `<button type="button" class="boton boton-chico" id="reintentar-comparar" ${reintentoPedido ? 'disabled' : ''}>${reintentoPedido ? 'Revisando la conexión…' : 'Reintentar'}</button>`;
    cont.innerHTML = `${cabeza}<p>${estado('aviso', f.corto)}</p><p class="nota" style="margin-top:6px">${escapar(f.vencida ? f.texto : comparacion.error)}</p>
      <p style="margin-top:10px">${boton}</p>`;
    conectarElegirArchivo(cont);
    // Solo se revisa la conexión: si responde, el aviso 'conexion' del bus vuelve a comparar (una sola vez)
    cont.querySelector('#reintentar-comparar')?.addEventListener('click', () => {
      reintentoPedido = true;
      pintarComparacion();
      revisarConexion();
    });
    return;
  }
  const d = comparacion.datos;
  if (d.yaCargado) {
    // Cargarlo otra vez queda como repetido y no toca ningún ticket: no hay cifras que mostrar
    const y = d.yaCargado;
    cont.innerHTML = `${cabeza}<p>${estadoLargo('info', 'No cambia nada: es un archivo repetido')}</p>
      <p style="margin-top:6px">Este mismo archivo ya se cargó en la carga ${escapar(y.cargaId)} (${escapar(y.archivo)}, ${escapar(momento(y.cuando))}). Si se carga otra vez, queda registrado como repetido y ${esCompras() ? 'ninguna compra' : 'ningún ticket'} cambia; por eso "Cargar a la base" está desactivado.</p>`;
    return;
  }
  const campos = d.camposQueCambian.map((x) => `${x.campo} (${fmt.entero(x.tickets)})`).join(', ');
  if (esCompras()) {
    cont.innerHTML = `${cabeza}
      <div class="comparacion">
        ${indicador('Compras nuevas', fmt.entero(d.nuevos), 'Entran por primera vez')}
        ${indicador('Se actualizan', fmt.entero(d.cambian), campos ? `Cambia: ${campos}` : 'Ya estaban, con datos distintos')}
        ${indicador('Quedan iguales', fmt.entero(d.iguales), 'Ya estaban, sin cambios')}
      </div>
      <p class="nota" style="margin-top:10px">Las compras de Diesel, Regular y Super suman al inventario desde su fecha y hora; los lubricantes se guardan, pero no entran al inventario de galones.</p>`;
    return;
  }
  cont.innerHTML = `${cabeza}
    <div class="comparacion">
      ${indicador('Tickets nuevos', fmt.entero(d.nuevos), 'Entran por primera vez')}
      ${indicador('Se actualizan', fmt.entero(d.cambian), campos ? `Cambia: ${campos}` : 'Ya estaban, con datos distintos')}
      ${indicador('Quedan iguales', fmt.entero(d.iguales), 'Ya estaban, sin cambios')}
      ${indicador('Pierden su factura', fmt.entero(d.pierdenFactura), d.pierdenFactura ? 'En la base tienen factura y aquí no' : 'Ninguno')}
    </div>
    ${d.seMuevenDeDia ? `<p class="nota" style="margin-top:10px">${escapar(`${plural(d.seMuevenDeDia, 'ticket ya estaba', 'tickets ya estaban')} en la base con otra fecha: la carga ${d.seMuevenDeDia === 1 ? 'lo pasa' : 'los pasa'} a la fecha de este archivo.`)}</p>` : ''}
    ${d.pierdenFactura ? `<p style="margin-top:10px">${estadoLargo('aviso', 'Revisa si este archivo es una exportación más vieja que la última cargada: el último archivo manda.')}</p>` : ''}`;
}

const indicador = (titulo, valor, nota) =>
  `<div class="indicador"><div class="indicador-titulo">${escapar(titulo)}</div><div class="indicador-valor num">${escapar(valor)}</div><div class="indicador-nota">${escapar(nota)}</div></div>`;

function pintarGraficasPrevia() {
  const cont = previaEl.querySelector('#graficas-previa');
  const a = previa.agregados;
  if (!a.total.tickets) {
    cont.hidden = true;
    return;
  }
  const medidas = [
    { valor: 'total', texto: 'Venta' },
    { valor: 'galones', texto: 'Galones' },
  ];
  const formatoDe = (m) => (m === 'galones' ? fmt.galones : fmt.moneda);
  const ejeDe = (m) => (m === 'galones' ? fmt.galonesCorto : fmt.monedaCorta);

  // Por día
  const tDia = tarjeta({ titulo: 'Ventas por día', subtitulo: 'Por producto, según la fecha del ticket', alto: 280, clase: 'col-8', controles: segmentado('medida-dia', medidas, 'total') });
  const dibujarDia = (m) => {
    const { categorias, series } = pivotar(a.porDia, 'fecha', m);
    barrasApiladas(tDia.grafica, {
      categorias,
      series,
      formato: formatoDe(m),
      formatoEje: ejeDe(m),
      etiqueta: (x) => fecha(x),
      titulo: (x) => `${diaSemana(x)} ${fecha(x, true)}`,
    });
    tDia.ponerTabla(tablaPivote(categorias, series, (x) => `${diaSemana(x)} ${fecha(x, true)}`, 'Fecha', formatoDe(m)));
  };
  conectarSegmentado(tDia.el, 'medida-dia', dibujarDia);

  // Por producto
  const tProd = tarjeta({ titulo: 'Por producto', subtitulo: 'Venta total del archivo', alto: 280, clase: 'col-4' });
  const productos = [...a.productos].sort((x, y) => y.total - x.total);
  barrasHorizontales(tProd.grafica, {
    categorias: productos.map((p) => p.producto),
    valores: productos.map((p) => p.total),
    colorDe: (producto, _i, c) => colorProducto(producto, c),
    formato: fmt.moneda,
    formatoEje: fmt.monedaCorta,
    nombreMedida: 'Venta',
    etiqueta: (i) => `${fmt.monedaCorta(productos[i].total)} · ${fmt.pct(pct(productos[i].total, a.total.total))}`,
    nota: (i) => `${fmt.galones(productos[i].galones)} · ${plural(productos[i].tickets, 'ticket', 'tickets')}`,
  });
  tProd.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Producto', valor: (p) => (p.esPie ? 'Total' : conPunto(p.producto, varProducto(p.producto))), html: true },
        { titulo: 'Tickets', valor: (p) => fmt.entero(p.tickets), der: true },
        { titulo: 'Galones', valor: (p) => fmt.numero(p.galones), der: true },
        { titulo: 'Venta', valor: (p) => fmt.moneda(p.total), der: true },
        { titulo: 'Utilidad', valor: (p) => fmt.moneda(p.utilidad), der: true },
      ],
      productos,
      { pie: { ...a.total, esPie: true } },
    ),
  );

  // Por turno
  const tTurno = tarjeta({ titulo: 'Ventas por turno', subtitulo: 'Por producto, según el número de turno de BISS', alto: 280, clase: 'col-8', controles: segmentado('medida-turno', medidas, 'total') });
  const dibujarTurno = (m) => {
    const { categorias, series } = pivotar(a.porTurno, 'turno', m, (x, y) => x - y);
    barrasApiladas(tTurno.grafica, { categorias, series, formato: formatoDe(m), formatoEje: ejeDe(m), titulo: (x) => `Turno ${x}` });
    tTurno.ponerTabla(tablaPivote(categorias, series, (x) => `Turno ${x}`, 'Turno', formatoDe(m)));
  };
  conectarSegmentado(tTurno.el, 'medida-turno', dibujarTurno);

  // Facturación
  const tFact = tarjeta({ titulo: 'Facturación', subtitulo: 'Venta según cómo se facturó el ticket', alto: 280, clase: 'col-4' });
  const ORDEN_FACT = ['FACTURA INDIVIDUAL', 'FACTURA GLOBAL', 'SIN FACTURA'];
  const fact = [...a.facturacion].sort((x, y) => ORDEN_FACT.indexOf(x.tipo) - ORDEN_FACT.indexOf(y.tipo));
  barrasHorizontales(tFact.grafica, {
    categorias: fact.map((f) => nombreFacturacion(f.tipo)),
    valores: fact.map((f) => f.total),
    formato: fmt.moneda,
    formatoEje: fmt.monedaCorta,
    nombreMedida: 'Venta',
    etiqueta: (i) => `${fmt.monedaCorta(fact[i].total)} · ${fmt.pct(pct(fact[i].total, a.total.total))}`,
    nota: (i) => plural(fact[i].tickets, 'ticket', 'tickets'),
  });
  tFact.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Facturación', valor: (f) => nombreFacturacion(f.tipo) },
        { titulo: 'Tickets', valor: (f) => fmt.entero(f.tickets), der: true },
        { titulo: 'Venta', valor: (f) => fmt.moneda(f.total), der: true },
        { titulo: '% de la venta', valor: (f) => fmt.pct(pct(f.total, a.total.total)), der: true },
      ],
      fact,
    ),
  );

  cont.append(tDia.el, tProd.el, tTurno.el, tFact.el);
  dibujarDia('total');
  dibujarTurno('total');
}

export const nombreFacturacion = (t) => ({ 'SIN FACTURA': 'Sin factura', 'FACTURA GLOBAL': 'Factura global', 'FACTURA INDIVIDUAL': 'Factura individual' })[t] ?? t;

/** Tabla de una gráfica apilada: una fila por categoría y una columna por producto */
export function tablaPivote(categorias, series, etiqueta, tituloCategoria, formato) {
  const filas = categorias.map((x, i) => ({ x, valores: series.map((s) => s.valores[i]), total: series.reduce((a, s) => a + s.valores[i], 0) }));
  const pie = { x: 'Total', valores: series.map((s) => s.valores.reduce((a, v) => a + v, 0)), total: filas.reduce((a, f) => a + f.total, 0), esPie: true };
  return tablaHtml(
    [
      { titulo: tituloCategoria, valor: (f) => (f.esPie ? 'Total' : etiqueta(f.x)) },
      ...series.map((s, k) => ({ titulo: s.nombre, valor: (f) => formato(f.valores[k]), der: true })),
      ...(series.length > 1 ? [{ titulo: 'Total', valor: (f) => formato(f.total), der: true }] : []),
    ],
    filas,
    { pie },
  );
}

function pintarCuadre() {
  const cont = previaEl.querySelector('#cuadre');
  const filas = previa.cuadre;
  const malos = filas.filter((f) => !f.cuadra);
  const grupos = new Set(filas.map((f) => f.grupo)).size;
  const resumen = !filas.length
    ? estadoLargo('info', 'No hubo subtotales para comparar')
    : malos.length
      ? estadoLargo('critico', `${fmt.entero(malos.length)} de ${plural(filas.length, 'comparación no cuadra', 'comparaciones no cuadran')}`)
      : estadoLargo('bueno', `Todo cuadra: ${plural(grupos, 'grupo', 'grupos')}, ${plural(filas.length, 'comparación', 'comparaciones')}`);
  const MEDIDAS = {
    cantidad: esCompras() ? 'Cantidad' : 'Galones',
    iva: 'IVA',
    idp: 'IDP',
    descuento: 'Descuento',
    total: 'Total',
    total_neto: 'Total neto',
    costo_total: 'Costo',
    utilidad: 'Utilidad',
    fob_total: 'Costo FOB',
    cif_total: 'CIF',
  };
  cont.innerHTML = `
    <div class="tarjeta-cabeza"><div><h3>Cuadre contra el reporte</h3><p class="tarjeta-sub">La suma de ${esCompras() ? 'las compras' : 'los tickets'} contra los subtotales que imprime BISS, con la tolerancia de los decimales impresos.</p></div></div>
    <p>${resumen}</p>
    ${
      filas.length
        ? `<details style="margin-top:10px"><summary class="boton-texto">${filas.length === 1 ? 'Ver la comparación' : `Ver las ${fmt.entero(filas.length)} comparaciones`}</summary><div style="margin-top:10px;max-height:320px;overflow:auto">${tablaHtml(
            [
              { titulo: 'Grupo', valor: (f) => f.grupo },
              { titulo: 'Medida', valor: (f) => MEDIDAS[f.medida] ?? f.medida },
              { titulo: esCompras() ? 'Suma compras' : 'Suma tickets', valor: (f) => fmt.numero(Number(f.suma), 2), der: true },
              { titulo: 'Reporte', valor: (f) => fmt.numero(Number(f.reporte), 2), der: true },
              { titulo: '', valor: (f) => (f.cuadra ? estado('bueno', 'Cuadra') : estado('critico', `Dif. ${fmt.numero(Number(f.diferencia), 4)}`)), html: true },
            ],
            [...malos, ...filas.filter((f) => f.cuadra)],
          )}</div></details>`
        : ''
    }`;
}

const MAX_A_LA_VISTA = 5; // los demás casos de una regla se ven en la tabla de tickets o en una caja con scroll
// Caja con scroll para las reglas que no caen en ningún ticket del archivo (huecos de numeración, por ejemplo)
const ESTILO_LISTA_LARGA = 'max-height:240px;overflow:auto;margin:4px 0 12px 6px;padding:6px 10px 6px 22px;border:1px solid var(--borde);border-radius:var(--radio-chico)';

function pintarIncidencias() {
  const cont = previaEl.querySelector('#incidencias');
  const grupos = previa.incidencias;
  const c = previa.conteoIncidencias;
  const detienen = c.ERROR === 1 ? ' (detiene la carga)' : c.ERROR > 1 ? ' (detienen la carga)' : '';
  cont.innerHTML = `
    <div class="tarjeta-cabeza"><div><h3>Revisión de calidad</h3>
      <p class="tarjeta-sub">${plural(c.ERROR, 'error', 'errores')}${detienen} · ${plural(c.ADVERTENCIA, 'advertencia', 'advertencias')} · ${plural(c.INFO, 'informativa', 'informativas')}</p></div></div>
    ${
      grupos.length
        ? `<ul class="lista-incidencias">${grupos
            .map((g) => {
              const s = SEVERIDAD[g.severidad];
              const resto = g.cantidad - g.ejemplos.length;
              // Sin fila en la tabla, el servidor manda todos los casos (hasta 500): la tabla no sirve para buscarlos
              const mas =
                resto <= 0
                  ? ''
                  : g.sinFila
                    ? `… y ${fmt.entero(resto)} más (aquí solo caben los primeros ${fmt.entero(g.ejemplos.length)})`
                    : esCompras()
                      ? `… y ${fmt.entero(resto)} más (están en la columna Revisión de la tabla de compras)`
                      : `… y ${fmt.entero(resto)} más (filtra la tabla de tickets por "Con revisión")`;
              const larga = g.sinFila && g.ejemplos.length > MAX_A_LA_VISTA;
              const lista = larga
                ? `<ul tabindex="0" aria-label="${escapar(`${nombreRegla(g.regla)}: todos los casos`)}" style="${ESTILO_LISTA_LARGA}">`
                : '<ul>';
              return `<li><details><summary>${estado(s.tipo, s.texto)}<span>${escapar(nombreRegla(g.regla))}</span><span class="cuenta">${fmt.entero(g.cantidad)}</span></summary>
                ${lista}${g.ejemplos.map((e) => `<li>${escapar(e.mensaje)}</li>`).join('')}${mas ? `<li class="apagado">${escapar(mas)}</li>` : ''}</ul>
              </details></li>`;
            })
            .join('')}</ul>`
        : `<p>${estado('bueno', 'Sin observaciones')}</p>`
    }`;
}

// ---------------------------------------------------------------------------------------------
// Tabla de tickets (paginada en el servidor)

function pintarTablaTickets() {
  const cont = previaEl.querySelector('#tickets');
  if (!previa.resumen.tickets) {
    // Sin tickets leídos no hay filtros, búsqueda ni páginas que ofrecer
    cont.innerHTML = `<div class="tarjeta-cabeza"><div><h3>Tickets del archivo</h3></div></div>
      <div class="vacio"><strong>Sin tickets que mostrar</strong>No se pudo leer ningún ticket de este archivo. Arriba está el motivo.</div>`;
    return;
  }
  const productos = ordenarProductos(previa.agregados.productos.map((p) => p.producto));
  const filtros = [
    { valor: 'todos', texto: 'Todos' },
    { valor: 'incidencias', texto: 'Con revisión' },
    { valor: 'sin-factura', texto: 'Sin factura' },
    { valor: 'nuevos', texto: 'Nuevos' },
    { valor: 'cambian', texto: 'Se actualizan' },
  ];
  cont.innerHTML = `
    <div class="tarjeta-cabeza"><div><h3>Tickets del archivo</h3><p class="tarjeta-sub">Así entrarán al modelo. Para ver el detalle de una revisión o de un cambio, ábrelo con un clic, un toque o la tecla Enter.</p></div></div>
    <div class="tabla-barra">
      ${segmentado('filtro-tickets', filtros, tabla.filtro)}
      <select class="entrada" id="tickets-producto" aria-label="Producto">
        <option value="">Todos los productos</option>
        ${productos.map((p) => `<option value="${escapar(p)}">${escapar(p)}</option>`).join('')}
      </select>
      <input type="search" class="entrada" id="tickets-buscar" placeholder="Buscar ticket, cliente, NIT, factura…" aria-label="Buscar" />
    </div>
    <div id="tickets-tabla"><div class="cargando"><span class="girador"></span>Leyendo tickets…</div></div>
    <div class="paginacion" id="tickets-paginas"></div>`;
  conectarSegmentado(cont, 'filtro-tickets', (v) => {
    tabla.filtro = v;
    tabla.pagina = 1;
    cargarTickets();
  });
  cont.querySelector('#tickets-producto').addEventListener('change', (e) => {
    tabla.producto = e.target.value;
    tabla.pagina = 1;
    cargarTickets();
  });
  let espera;
  cont.querySelector('#tickets-buscar').addEventListener('input', (e) => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      tabla.buscar = e.target.value;
      tabla.pagina = 1;
      cargarTickets();
    }, 250);
  });
  actualizarFiltrosComparacion();
}

function actualizarFiltrosComparacion() {
  const cont = previaEl.querySelector('#tickets');
  if (!cont) return;
  // Con un archivo ya cargado no se compara ticket por ticket: no hay nuevos ni actualizados
  const yaCargado = Boolean(comparacion?.ok && comparacion.datos.yaCargado);
  const disponible = comparacion?.ok && !yaCargado;
  for (const v of ['nuevos', 'cambian']) {
    const b = cont.querySelector(`[data-segmentado="filtro-tickets"] [data-valor="${v}"]`);
    if (!b) continue;
    b.disabled = !disponible;
    b.title = disponible ? '' : yaCargado ? 'No aplica: este archivo ya está cargado' : 'Disponible cuando se compare con la base';
  }
}

let pedidoTickets = 0;
async function cargarTickets() {
  // Después de cargarlo (o si venció), el servidor ya no guarda la vista previa. Las compras no tienen tabla paginada
  if (!previa || esCompras() || !previa.resumen.tickets || previaCerrada()) return;
  actualizarFiltrosComparacion();
  const yo = ++pedidoTickets;
  const token = previa.token;
  const q = new URLSearchParams({ pagina: tabla.pagina, porPagina: tabla.porPagina, filtro: tabla.filtro });
  if (tabla.buscar.trim()) q.set('buscar', tabla.buscar.trim());
  if (tabla.producto) q.set('producto', tabla.producto);
  const cont = previaEl.querySelector('#tickets-tabla');
  const paginas = previaEl.querySelector('#tickets-paginas');
  if (!cont) return;
  // Una respuesta de otro archivo (o de antes de cancelar) no debe pintar ni mover la página
  const vigente = () => yo === pedidoTickets && previa?.token === token;
  let d;
  try {
    d = await pedir(`/api/vista-previa/${token}/tickets?${q}`);
  } catch (err) {
    if (vigente()) {
      cont.innerHTML = `<p>${estadoLargo('critico', err.message)}</p>`;
      paginas.innerHTML = '';
    }
    return;
  }
  if (!vigente()) return;
  tabla.pagina = d.pagina;
  // "En la base" solo cuando hay comparación ticket por ticket (no mientras se compara, si falló o si el archivo ya está cargado)
  const conBase = d.comparado !== false;
  cont.innerHTML = tablaHtml(
    [
      { titulo: 'Ticket', valor: (t) => t.ticket },
      { titulo: 'Fecha y hora', valor: (t) => `<span class="nowrap">${escapar(fechaHora(t.fechaHora))}</span>`, html: true },
      { titulo: 'Turno', valor: (t) => t.turno, der: true },
      { titulo: 'Bomba', valor: (t) => t.bomba ?? '–', der: true },
      { titulo: 'Producto', valor: (t) => conPunto(t.producto, varProducto(t.producto)), html: true },
      { titulo: 'Galones', valor: (t) => fmt.numero(t.galones, 3), der: true },
      { titulo: 'Precio', valor: (t) => fmt.numero(t.precio, 2), der: true },
      { titulo: 'Total', valor: (t) => fmt.moneda(t.total), der: true },
      { titulo: 'Utilidad', valor: (t) => fmt.moneda(t.utilidad), der: true },
      { titulo: 'Cliente', valor: (t) => t.cliente ?? '–' },
      { titulo: 'Factura', valor: (t) => t.factura ?? 'Sin factura' },
      { titulo: 'Pricebook', valor: (t) => t.pricebook ?? '–' },
      ...(conBase ? [{ titulo: 'En la base', valor: (t) => enBase(t.enBase), html: true }] : []),
      { titulo: 'Revisión', valor: (t) => revision(t.incidencia), html: true },
    ],
    d.filas,
    { vacio: 'Ningún ticket con este filtro' },
  );
  const desde = d.total ? (d.pagina - 1) * tabla.porPagina + 1 : 0;
  const hasta = Math.min(d.pagina * tabla.porPagina, d.total);
  paginas.innerHTML = `<span>${d.total ? `Mostrando ${fmt.entero(desde)} a ${fmt.entero(hasta)} de ${fmt.entero(d.total)}` : ''}</span>
    <div><button type="button" class="boton boton-chico" data-pagina="-1" ${d.pagina <= 1 ? 'disabled' : ''}>Anterior</button>
    <span class="paginacion-pagina" style="align-self:center">Página ${fmt.entero(d.pagina)} de ${fmt.entero(d.paginas)}</span>
    <button type="button" class="boton boton-chico" data-pagina="1" ${d.pagina >= d.paginas ? 'disabled' : ''}>Siguiente</button></div>`;
  paginas.querySelectorAll('[data-pagina]').forEach((b) =>
    b.addEventListener('click', () => {
      tabla.pagina += Number(b.dataset.pagina);
      cargarTickets();
    }),
  );
}

/** Detalle desplegable dentro de una celda: se abre con clic, toque o teclado (Enter o espacio) */
const detalle = (resumen, lineas) =>
  `<details class="detalle-celda"><summary>${resumen}</summary><ul>${lineas.map((x) => `<li>${escapar(x)}</li>`).join('')}</ul></details>`;

function enBase(e) {
  if (!e) return '<span class="apagado">–</span>';
  if (e.estado === 'NUEVO') return insignia('info', 'Nuevo');
  if (e.estado === 'IGUAL') return '<span class="apagado">Sin cambio</span>';
  const cambios = e.cambios ?? [];
  if (cambios.length <= 1) return insignia('aviso', cambios.length ? `Cambia: ${cambios[0]}` : 'Cambia');
  return detalle(insignia('aviso', `Cambian ${cambios.length} datos`), cambios);
}

function revision(i) {
  if (!i) return '';
  const s = SEVERIDAD[i.severidad];
  const marca = estado(s.tipo, i.cantidad > 1 ? `${s.texto} (${i.cantidad})` : s.texto);
  return i.mensajes?.length ? detalle(marca, i.mensajes) : marca;
}

// ---------------------------------------------------------------------------------------------
// Cargar a la base

function pintarAccion() {
  const cont = previaEl.querySelector('#accion');
  if (!cont || !previa) return;
  if (resultado) {
    cont.innerHTML = '';
    return;
  }
  const vencida = errorCarga?.estado === 404;
  let motivo = '';
  if (!previa.valido) motivo = 'El archivo tiene errores: no se puede cargar.';
  else if (!comparacion) motivo = 'Comparando con la base…';
  else if (!comparacion.ok) motivo = falloComparacion().accion;
  else if (comparacion.datos.yaCargado) motivo = `Este archivo ya está en la base (carga ${comparacion.datos.yaCargado.cargaId}): cargarlo otra vez no cambia nada.`;
  else if (vencida) motivo = 'La vista previa venció: vuelve a subir el archivo para cargarlo.';
  const puede = !motivo && !cargando;
  const d = comparacion?.ok ? comparacion.datos : null;
  const texto = cargando
    ? '<span class="girador" style="display:inline-block;vertical-align:-3px;margin-right:8px"></span>Cargando a la base… no cierres esta ventana.'
    : motivo
      ? escapar(motivo)
      : escapar(
          esCompras()
            ? `Se cargarán ${filas(filasLeidas())} con el ETL de compras: ${plural(d.nuevos, 'nueva', 'nuevas')}, ${plural(d.cambian, 'se actualiza', 'se actualizan')} y ${fmt.entero(d.iguales)} sin cambio.`
            : `Se cargarán ${filas(filasLeidas())}: ${plural(d.nuevos, 'nuevo', 'nuevos')}, ${plural(d.cambian, 'se actualiza', 'se actualizan')} y ${fmt.entero(d.iguales)} sin cambio.`,
        );
  // El error del último intento queda a la vista hasta que se intente otra vez o se cambie de archivo
  const aviso = errorCarga && !cargando ? avisoErrorCarga(errorCarga) : '';
  cont.innerHTML = `${aviso}<div class="barra-accion"><p>${texto}</p>
    <button type="button" class="boton" id="cancelar" ${cargando ? 'disabled' : ''}>Cancelar</button>
    <button type="button" class="boton boton-principal" id="cargar" ${puede ? '' : 'disabled'}>Cargar a la base</button></div>`;
  cont.querySelector('#cancelar').addEventListener('click', limpiar);
  cont.querySelector('#cargar').addEventListener('click', cargarABase);
  conectarElegirArchivo(cont);
}

function avisoErrorCarga(err) {
  const vencida = err.estado === 404;
  const texto = vencida
    ? 'La vista previa ya no está disponible (dura 30 minutos o se reinició el panel). No se cargó nada: vuelve a subir el archivo.'
    : err.message;
  const nota =
    err.tipo === 'conexion' ? 'El archivo sigue aquí: cuando vuelva la conexión, presiona otra vez "Cargar a la base". No quedó nada a medias.' : '';
  return `<div class="veredicto veredicto-critico" role="alert" style="margin-bottom:12px">${ICONOS.critico}
    <div style="min-width:0;overflow-wrap:anywhere"><h2>No se pudo cargar</h2><p>${escapar(texto)}</p>${nota ? `<p>${escapar(nota)}</p>` : ''}</div>
    ${vencida ? `<div class="veredicto-acciones">${botonElegirArchivo}</div>` : ''}
  </div>`;
}

function limpiar() {
  pedidoPrevia++; // una vista previa que todavía venía en camino ya no se pinta
  archivoActual = null;
  previa = null;
  comparacion = null;
  resultado = null;
  errorCarga = null;
  reintentoPedido = false;
  previaEl.innerHTML = '';
  avisoZona('');
  raiz.querySelector('#zona').focus();
}

async function cargarABase() {
  if (cargando || !previa || resultado) return;
  cargando = true;
  errorCarga = null;
  pintarZona();
  pintarAccion();
  const usuario = raiz.querySelector('#usuario').value.trim();
  let r;
  try {
    r = await pedir('/api/cargas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: previa.token, usuario: usuario || undefined }),
    });
  } catch (err) {
    cargando = false;
    errorCarga = err;
    pintarZona();
    pintarAccion();
    if (err.estado === 404) {
      // La vista previa venció: arriba ya no dice "Listo" y la tabla deja de pedir páginas que darían 404
      pintarVeredicto();
      cerrarTablaTickets(NOTA_VENCIDA);
    }
    previaEl.querySelector('#accion')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (err.tipo === 'conexion') revisarConexion();
    return;
  }
  cargando = false;
  resultado = r;
  pintarZona();
  pintarResultado();
  avisar('carga-terminada', resultado);
  revisarConexion();
}

const NOTA_CARGADO =
  'La vista previa se cerró porque el archivo ya está en la base: los filtros, la búsqueda y las páginas ya no funcionan. La carga aparece en "Historial de cargas" y sus tickets en el Dashboard.';

/** Cuando el servidor olvida la vista previa (se cargó o venció), la tabla queda como está, sin filtros ni páginas */
function cerrarTablaTickets(nota) {
  const cont = previaEl.querySelector('#tickets');
  const barra = cont?.querySelector('.tabla-barra');
  if (!barra) return; // sin tickets no hay tabla que cerrar
  pedidoTickets++; // una respuesta que venía en camino ya no se pinta
  cont.querySelectorAll('.tabla-barra button, .tabla-barra select, .tabla-barra input, #tickets-paginas button').forEach((x) => (x.disabled = true));
  cont.querySelector('[data-tabla-cerrada]')?.remove();
  barra.insertAdjacentHTML('beforebegin', `<p class="nota" data-tabla-cerrada style="margin-bottom:10px">${escapar(nota)}</p>`);
}

function pintarResultado() {
  const r = resultado;
  const tipo = r.estado === 'CARGADO' ? 'bueno' : r.estado === 'RECHAZADO' ? 'critico' : 'info';
  const titulo = r.estado === 'CARGADO' ? `Cargado (carga ${r.carga_id})` : r.estado === 'RECHAZADO' ? `Rechazado (carga ${r.carga_id})` : `No se cargó: archivo repetido (registro ${r.carga_id})`;
  const cont = previaEl.querySelector('#veredicto');
  cont.innerHTML = `
    <div class="veredicto veredicto-${tipo}" role="status">${ICONOS[tipo]}
      <div style="min-width:0;overflow-wrap:anywhere">
        <h2>${escapar(titulo)}</h2>
        <p>${escapar(r.mensaje)}${r.estado === 'CARGADO' ? escapar(` (${fmt.numero(r.segundos, 1)} s)`) : ''}</p>
        ${r.aviso ? `<p>${estadoLargo('aviso', r.aviso)}</p>` : ''}
        ${r.archivado ? `<p class="nota">Copia del archivo guardada en <span class="ruta">${escapar(r.archivado)}</span></p>` : ''}
        ${r.avisoArchivo ? `<p>${estadoLargo('aviso', r.avisoArchivo)}</p>` : ''}
      </div>
      <div class="veredicto-acciones">
        ${
          r.estado !== 'CARGADO'
            ? ''
            : r.tipo === 'COMPRAS'
              ? '<a class="boton boton-principal" href="#inventario">Ver en el inventario</a>'
              : '<a class="boton boton-principal" href="#dashboard">Ver en el dashboard</a>'
        }
        <button type="button" class="boton" id="otro-archivo">Subir otro archivo</button>
      </div>
    </div>`;
  cont.querySelector('#otro-archivo').addEventListener('click', limpiar);
  pintarAccion();
  if (r.estado === 'CARGADO') cerrarTablaTickets(NOTA_CARGADO);
  // El margen de arriba de #veredicto (estilos.css) deja el resultado debajo del encabezado fijo
  cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
