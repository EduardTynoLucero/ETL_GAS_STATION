// Pestaña "Inventario": existencia inicial, compras, ventas y existencia final de cada combustible en el rango
// de fechas elegido, las compras y las tomas físicas del periodo (se registran en la pestaña "Tomas físicas"). La
// existencia de cualquier momento sale de la toma física más cercana: sin ninguna toma de un producto, su
// existencia no se puede saber.
import { bus, conexion, pedir, preferencia, revisarConexion } from './estado.js';
import {
  barrasApiladas,
  cascada,
  colorProducto,
  conectarSegmentado,
  conPunto,
  Grafica,
  lineas,
  medidor,
  ordenarProductos,
  pivotar,
  segmentado,
  tablaHtml,
  tarjeta,
  varProducto,
} from './graficas.js';
import { tablaPivote } from './cargar.js';
import { abrirModal, mensajeModal, ocupar } from './modal.js';
import { diaSemana, escapar, estado, estadoLargo, fecha, fechaHora, fmt, ICONOS, plural } from './util.js';

let raiz;
let opciones = null;
let filtros = {};
let pedido = 0;
let pendiente = true; // hay que volver a consultar (primera vez, después de una carga, de una toma o de un error)

export function iniciar(contenedor) {
  raiz = contenedor;
  raiz.innerHTML = `<div id="inv-filtros"></div><div id="inv-cuerpo" class="pila"></div>`;
  bus.addEventListener('carga-terminada', () => {
    pendiente = true;
    if (!raiz.hidden) cargar();
  });
  // Solo cuando terminó de revisar: el aviso del inicio de la revisión no dispara otra consulta
  bus.addEventListener('conexion', () => {
    if (pendiente && !conexion.revisando && !raiz.hidden) cargar();
  });
}

/** Cada vez que se abre la pestaña se vuelve a consultar: puede haber cargas o tomas nuevas */
export function mostrar() {
  pendiente = true;
  cargar();
}

// ---------------------------------------------------------------------------------------------
// Fechas y filtros

const iso = (d) => d.toISOString().slice(0, 10);
const masDias = (t, n) => iso(new Date(new Date(`${t}T00:00:00Z`).getTime() + n * 86400000));
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const RAPIDOS = [
  { valor: '7', texto: 'Últimos 7 días' },
  { valor: '30', texto: 'Últimos 30 días' },
  { valor: 'mes', texto: 'Este mes' },
];

function rangoRapido(tipo) {
  const max = opciones.rango.hasta;
  if (tipo === '30') return { desde: masDias(max, -29), hasta: max };
  if (tipo === 'mes') return { desde: `${max.slice(0, 7)}-01`, hasta: max };
  return { desde: masDias(max, -6), hasta: max };
}

async function cargar() {
  const cuerpo = raiz.querySelector('#inv-cuerpo');
  if (!conexion.datos || conexion.revisando) {
    cuerpo.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Revisando la conexión…</div>`;
    return;
  }
  if (!conexion.conectado) {
    pendiente = true;
    raiz.querySelector('#inv-filtros').innerHTML = '';
    cuerpo.innerHTML = `<div class="tarjeta vacio"><strong>El inventario necesita la base de datos</strong>${escapar(conexion.datos?.error ?? 'Sin conexión.')}
      <p style="margin-top:12px"><button type="button" class="boton" id="inv-reintentar">Reintentar</button></p></div>`;
    cuerpo.querySelector('#inv-reintentar').addEventListener('click', (ev) => {
      ev.target.disabled = true;
      revisarConexion();
    });
    return;
  }
  const yo = ++pedido;
  try {
    if (!opciones || pendiente) {
      const nuevas = await pedir('/api/inventario/opciones');
      if (yo !== pedido) return;
      opciones = nuevas;
    }
    if (!opciones.instalado) {
      pendiente = false;
      raiz.querySelector('#inv-filtros').innerHTML = '';
      cuerpo.innerHTML = `<div class="veredicto veredicto-aviso" role="status">${ICONOS.aviso}<div>
        <h2>Falta actualizar la base de datos</h2>
        <p>Para las compras, la toma física y el inventario, la base necesita las tablas de la versión 1.1.0. Ejecuta <span class="ruta">sql/actualizar_compras_inventario.sql</span> en pgAdmin (Query Tool sobre gas_station_db, F5), o en la consola: <span class="ruta">npm run instalar-bd</span>. No borra ni cambia nada de lo que ya está cargado.</p>
        </div><div class="veredicto-acciones"><button type="button" class="boton" id="inv-actualizar">Ya la actualicé</button></div></div>`;
      cuerpo.querySelector('#inv-actualizar').addEventListener('click', mostrar);
      return;
    }
    if (!opciones.estaciones.length) {
      pendiente = false;
      raiz.querySelector('#inv-filtros').innerHTML = '';
      cuerpo.innerHTML = `<div class="tarjeta vacio"><strong>Todavía no hay datos</strong>Carga la Consulta de Tickets o el Reporte de compras en la pestaña <a href="#cargar">Cargar reporte</a>.</div>`;
      return;
    }
    ponerFiltrosPorDefecto();
    pintarFiltros();
    cuerpo.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Calculando el inventario…</div>`;
    const q = new URLSearchParams({ estacion: filtros.estacion, desde: filtros.desde, hasta: filtros.hasta });
    // El nivel de los tanques es de ahora (no depende del rango): si falla, el resto del inventario igual se ve
    const [inv, tanques] = await Promise.all([
      pedir(`/api/inventario?${q}`),
      pedir(`/api/tanques?${new URLSearchParams({ estacion: filtros.estacion })}`).catch((err) => ({ error: err.message })),
    ]);
    if (yo !== pedido) return;
    pendiente = false;
    pintar(inv, tanques);
  } catch (err) {
    if (yo !== pedido) return;
    pendiente = true;
    cuerpo.innerHTML = `<div class="veredicto veredicto-critico">${ICONOS.critico}<div><h2>No se pudo calcular el inventario</h2><p>${escapar(err.message)}</p></div>
      <div class="veredicto-acciones"><button type="button" class="boton" id="inv-reintentar">Reintentar</button></div></div>`;
    cuerpo.querySelector('#inv-reintentar').addEventListener('click', (ev) => {
      ev.target.disabled = true;
      if (err.tipo === 'conexion') revisarConexion();
      else cargar();
    });
  }
}

function ponerFiltrosPorDefecto() {
  const codigos = opciones.estaciones.map((e) => e.codigo);
  if (!codigos.includes(filtros.estacion)) {
    const guardada = preferencia.leer('inventario-estacion', '');
    filtros.estacion = codigos.includes(guardada) ? guardada : codigos[0];
  }
  if (!filtros.desde || !filtros.hasta) {
    const hasta = opciones.rango.hasta ?? hoy();
    Object.assign(filtros, { desde: masDias(hasta, -6), hasta, rapido: '7' });
  }
}

function pintarFiltros() {
  const cont = raiz.querySelector('#inv-filtros');
  cont.innerHTML = `
    <div class="filtros" role="search" aria-label="Filtros del inventario">
      <label class="campo">Estación<select id="i-estacion">${opciones.estaciones
        .map((e) => `<option value="${escapar(e.codigo)}">${escapar(`${e.codigo} · ${e.nombre}`)}</option>`)
        .join('')}</select></label>
      <label class="campo">Desde<input type="date" id="i-desde" /></label>
      <label class="campo">Hasta<input type="date" id="i-hasta" /></label>
      <div class="campo">Rango rápido${segmentado('inv-rango', RAPIDOS, filtros.rapido ?? '')}</div>
      <span class="separador"></span>
      ${opciones.rango.desde ? `<span class="filtros-nota">Datos del ${escapar(fecha(opciones.rango.desde, true))} al ${escapar(fecha(opciones.rango.hasta, true))}</span>` : ''}
      <button type="button" class="boton boton-chico" id="i-actualizar">Actualizar</button>
    </div>`;
  cont.querySelector('#i-estacion').value = filtros.estacion;
  cont.querySelector('#i-desde').value = filtros.desde;
  cont.querySelector('#i-hasta').value = filtros.hasta;
  const aplicar = (editada) => {
    let desde = cont.querySelector('#i-desde').value;
    let hasta = cont.querySelector('#i-hasta').value;
    if (!desde || !hasta) return; // fecha a medio escribir
    // Nunca se intercambian: la otra fecha pasa a ser la que se acaba de editar
    if (desde > hasta) {
      if (editada === 'hasta') desde = hasta;
      else hasta = desde;
    }
    filtros = {
      estacion: cont.querySelector('#i-estacion').value,
      desde,
      hasta,
      rapido: editada === 'rapido' ? filtros.rapido : '',
      // El producto de la cascada se queda al cambiar las fechas
      cascada: filtros.cascada,
    };
    preferencia.guardar('inventario-estacion', filtros.estacion);
    pendiente = true;
    cargar();
  };
  cont.querySelector('#i-estacion').addEventListener('change', () => aplicar('estacion'));
  cont.querySelector('#i-desde').addEventListener('change', () => aplicar('desde'));
  cont.querySelector('#i-hasta').addEventListener('change', () => aplicar('hasta'));
  conectarSegmentado(cont, 'inv-rango', (v) => {
    const r = rangoRapido(v);
    filtros.rapido = v;
    cont.querySelector('#i-desde').value = r.desde;
    cont.querySelector('#i-hasta').value = r.hasta;
    aplicar('rapido');
  });
  cont.querySelector('#i-actualizar').addEventListener('click', mostrar);
}

// ---------------------------------------------------------------------------------------------

const rejilla = () => Object.assign(document.createElement('div'), { className: 'rejilla' });
const conSigno = (n) => (n > 0 ? `+${fmt.galones(n)}` : fmt.galones(n));
/** Faltante o sobrante de una toma contra lo teórico, con palabra (el color nunca va solo) */
function diferencia(n) {
  if (n === null || n === undefined) return '<span class="apagado">–</span>';
  if (Math.abs(n) < 0.0005) return estado('bueno', 'Cuadra');
  return estado(n < 0 ? 'aviso' : 'info', `${n < 0 ? 'Faltante' : 'Sobrante'} ${conSigno(n)}`);
}

function pintar(inv, tanques) {
  const cuerpo = raiz.querySelector('#inv-cuerpo');
  cuerpo.innerHTML = '';
  const productos = ordenarProductos(inv.productos.map((p) => p.producto)).map((n) => inv.productos.find((p) => p.producto === n));
  const sinToma = productos.filter((p) => p.inicial === null);

  const aviso = document.createElement('div');
  aviso.innerHTML = sinToma.length
    ? `<div class="veredicto veredicto-aviso" role="status">${ICONOS.aviso}<div><h2>${escapar(
        sinToma.length === productos.length ? 'Registra una toma física para ver las existencias' : `Falta una toma física de ${sinToma.map((p) => p.producto).join(', ')}`,
      )}</h2><p>La existencia sale de una medición de los tanques: con una sola toma, en cualquier fecha, el panel calcula hacia adelante y hacia atrás con las compras y las ventas cargadas.</p></div>
      <div class="veredicto-acciones"><a class="boton" href="#tomas">Registrar una toma física</a></div></div>`
    : `<p class="nota">Existencia inicial al empezar el ${escapar(fecha(inv.filtros.desde, true))} y final al terminar el ${escapar(fecha(inv.filtros.hasta, true))}, calculadas desde la toma física más cercana con las compras y las ventas cargadas. Una venta o compra a la misma hora de la toma cuenta como posterior a ella. Las tomas se registran, corrigen y anulan en la pestaña <a href="#tomas">Tomas físicas</a>.</p>`;
  cuerpo.append(nivelTanques(tanques), aviso);

  cuerpo.append(indicadores(productos), movimiento(inv, productos), cascadaPorDia(inv, productos));
  const fila1 = rejilla();
  fila1.append(existenciaPorDia(inv, productos), comprasVentasPorDia(inv));
  cuerpo.append(fila1, comprasDelPeriodo(inv), tomasDelPeriodo(inv));
}

// ---------------------------------------------------------------------------------------------
// Nivel actual de los tanques: un medidor con semáforo por combustible y la recomendación de pedido

const ESTADO_TANQUE = {
  URGENTE: 'critico',
  PRONTO: 'aviso',
  PROGRAMAR: 'info',
  ESTABLE: 'bueno',
  REVISAR: 'critico',
  SIN_TOMA: 'info',
  SIN_CAPACIDAD: 'info',
};
const ORDEN_ESTADO = ['URGENTE', 'REVISAR', 'PRONTO', 'PROGRAMAR', 'ESTABLE', 'SIN_CAPACIDAD', 'SIN_TOMA'];

function nivelTanques(t) {
  const sec = document.createElement('section');
  sec.className = 'tarjeta';
  const cabeza = (sub, boton) => `<div class="tarjeta-cabeza"><div><h2>Nivel actual de los tanques</h2><p class="tarjeta-sub">${sub}</p></div>
    ${boton ? '<div class="tarjeta-controles"><button type="button" class="boton boton-chico" id="tq-configurar">Configurar tanques</button></div>' : ''}</div>`;
  if (t.error) {
    sec.innerHTML = `${cabeza('', false)}<p>${estadoLargo('critico', t.error)}</p>`;
    return sec;
  }
  if (!t.instalado) {
    sec.innerHTML = `${cabeza('', false)}<p>${estadoLargo(
      'aviso',
      'Para ver el nivel de los tanques y las recomendaciones de pedido, ejecuta sql/actualizar_tanques.sql en pgAdmin (o npm run instalar-bd) y vuelve a abrir esta pestaña.',
    )}</p>`;
    return sec;
  }
  const tanques = ordenarProductos(t.tanques.map((x) => x.producto)).map((n) => t.tanques.find((x) => x.producto === n));
  // Resumen: cuántos tanques hay en cada estado, de lo más grave a lo más tranquilo
  const cuenta = ORDEN_ESTADO.map((e) => [e, tanques.filter((x) => x.estado === e)]).filter(([, l]) => l.length);
  const resumen = cuenta.map(([e, l]) => estado(ESTADO_TANQUE[e], `${l.map((x) => x.producto).join(', ')}: ${l[0].titulo}`)).join(' ');
  sec.innerHTML = `${cabeza(
    escapar(`Estimado al ${fechaHora(t.ahora)} desde la última toma física, con las compras y las ventas cargadas. El semáforo: rojo, pedir ya; amarillo, pedir pronto; verde, estable; gris, arriba del llenado máximo.`),
    true,
  )}
    <p style="display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:12px">${resumen}</p>
    <div class="rejilla" id="tq-tanques"></div>`;
  const cont = sec.querySelector('#tq-tanques');
  for (const x of tanques) cont.append(tarjetaTanque(x));
  sec.querySelector('#tq-configurar').addEventListener('click', () => configurarTanques(t));
  return sec;
}

function tarjetaTanque(x) {
  const div = document.createElement('div');
  div.className = 'col-4 tanque';
  const p = x.parametros;
  const dato = (titulo, valor, nota = '') =>
    `<div class="dato"><dt>${escapar(titulo)}</dt><dd class="num">${escapar(valor)}${nota ? `<small>${escapar(nota)}</small>` : ''}</dd></div>`;
  const dias = (n) => (n === null ? '–' : n >= 1 ? `${fmt.numero(n, 1)} días` : `${fmt.numero(n * 24, 0)} horas`);
  div.innerHTML = `
    <div class="tanque-cabeza">${conPunto(x.producto, varProducto(x.producto))}${estado(ESTADO_TANQUE[x.estado], x.titulo)}</div>
    <div class="grafica" style="height:210px" role="img" aria-label="${escapar(
      `${x.producto}: ${x.porcentaje === null ? 'sin porcentaje' : `${fmt.numero(x.porcentaje, 1)}% de ocupación`}. ${x.titulo}`,
    )}"></div>
    <dl class="datos">
      ${dato('Galonaje actual', x.galones === null ? '–' : `${x.estimado ? '≈ ' : ''}${fmt.galones(x.galones)}`, x.estimado ? 'estimado a esta hora' : '')}
      ${dato('Capacidad', p ? fmt.galones(p.capacidad_galones) : 'Sin configurar', p ? `llenado máximo ${fmt.pct(p.llenado_maximo_pct, 0)}` : '')}
      ${dato('Ocupación', x.porcentaje === null ? '–' : fmt.pct(x.porcentaje), x.espacioLibre !== null ? `caben ${fmt.galones(x.espacioLibre)}` : '')}
      ${dato('Alcanza para', dias(x.coberturaDias), x.agotamiento ? `se acaba el ${fechaHora(x.agotamiento)}` : '')}
      ${dato('Venta promedio', `${fmt.galones(x.consumoDiario)} / día`, x.diasConsumo ? `últimos ${x.diasConsumo} días` : '')}
      ${dato('Pedir', x.fechaPedido ? (x.diasParaPedir <= 0 ? 'Hoy' : fechaHora(x.fechaPedido)) : '–', x.pedidoSugerido ? `${fmt.galones(x.pedidoSugerido)} sugeridos` : '')}
    </dl>
    <p style="margin-top:10px">${escapar(x.recomendacion)}</p>
    <p class="nota" style="margin-top:6px">${escapar(
      [x.toma ? `Última toma: ${fechaHora(x.toma.en)}, ${fmt.galones(x.toma.galones)}` : null, x.ultimaCompra ? `última compra: ${fechaHora(x.ultimaCompra.en)}, ${fmt.galones(x.ultimaCompra.galones)}` : null]
        .filter(Boolean)
        .join(' · '),
    )}</p>
    ${x.avisos.map((a) => `<p class="nota" style="margin-top:4px">${estadoLargo('aviso', a)}</p>`).join('')}`;
  // El medidor se dibuja cuando la tarjeta ya está en la página (Grafica se ajusta a su caja)
  const g = new Grafica(div.querySelector('.grafica'));
  medidor(g, {
    porcentaje: x.porcentaje,
    umbrales: x.umbrales,
    texto: x.galones === null ? 'Sin toma física' : p ? `${fmt.galones(x.galones)} de ${fmt.galones(p.capacidad_galones)}` : 'Configura la capacidad',
    colorAguja: (c) => ({ URGENTE: c.critico, REVISAR: c.critico, PRONTO: c.aviso, ESTABLE: c.bueno })[x.estado] ?? c.tinta,
  });
  return div;
}

const CAMPOS_TANQUE = [
  { clave: 'capacidad_galones', titulo: 'Capacidad (gal)', ayuda: 'Suma de los tanques del producto', paso: '1', min: 1 },
  { clave: 'tiempo_entrega_dias', titulo: 'Entrega (días)', ayuda: 'Del pedido a la descarga', paso: '0.5', min: 0 },
  { clave: 'dias_seguridad', titulo: 'Reserva (días)', ayuda: 'Venta que debe quedar al llegar', paso: '0.5', min: 0 },
  { clave: 'nivel_minimo_pct', titulo: 'Mínimo (%)', ayuda: 'Debajo de esto, pedir ya', paso: '1', min: 0 },
  { clave: 'llenado_maximo_pct', titulo: 'Llenado máximo (%)', ayuda: 'Hasta dónde se llena', paso: '1', min: 1 },
  { clave: 'multiplo_pedido', titulo: 'Pedidos de (gal)', ayuda: 'Múltiplo de cada pedido', paso: '100', min: 1 },
  { clave: 'horizonte_dias', titulo: 'Proyectar (días)', ayuda: 'Ventana para programar', paso: '1', min: 1 },
  { clave: 'dias_consumo', titulo: 'Promedio de (días)', ayuda: 'Días para la venta promedio', paso: '1', min: 3 },
];

function configurarTanques(t) {
  const productos = ordenarProductos(t.tanques.map((x) => x.producto));
  const valor = (x, k) => x.parametros?.[k] ?? (k === 'capacidad_galones' ? '' : t.porDefecto[k]);
  const filas = productos
    .map((nombre) => {
      const x = t.tanques.find((y) => y.producto === nombre);
      return `<tr data-producto="${escapar(nombre)}"><th scope="row">${conPunto(nombre, varProducto(nombre))}</th>${CAMPOS_TANQUE.map(
        (c) =>
          `<td><input class="entrada" style="width:7.5em" type="number" inputmode="decimal" name="${c.clave}" min="${c.min}" step="${c.paso}" value="${escapar(valor(x, c.clave))}" aria-label="${escapar(`${nombre}: ${c.titulo}`)}" /></td>`,
      ).join('')}</tr>`;
    })
    .join('');
  const cuerpo = `
    <p class="nota" style="margin-bottom:12px">La capacidad es la suma de los tanques de cada combustible, en galones. Los demás valores deciden el semáforo; los que ya vienen son un punto de partida. Un producto sin capacidad no se guarda.</p>
    <div class="tabla-contenedor"><table class="tabla"><thead><tr><th scope="col">Combustible</th>${CAMPOS_TANQUE.map(
      (c) => `<th scope="col" title="${escapar(c.ayuda)}">${escapar(c.titulo)}<br /><small class="apagado" style="font-weight:400">${escapar(c.ayuda)}</small></th>`,
    ).join('')}</tr></thead><tbody>${filas}</tbody></table></div>
    <label class="campo" style="margin-top:12px;max-width:320px">Tu nombre<input type="text" name="usuario" maxlength="60" autocomplete="name" /></label>
    <div data-mensaje role="status"></div>`;
  const d = abrirModal({
    titulo: `Configurar tanques · ${t.estacion}`,
    cuerpo,
    pie: '<button type="button" class="boton" data-cerrar>Cancelar</button><button type="button" class="boton boton-principal" data-guardar>Guardar</button>',
    ancho: true,
  });
  d.querySelector('input[name="usuario"]').value = preferencia.leer('usuario', '');
  d.querySelector('input[name="capacidad_galones"]')?.focus();
  d.querySelector('[data-guardar]').addEventListener('click', async () => {
    const usuario = d.querySelector('input[name="usuario"]').value.trim();
    preferencia.guardar('usuario', usuario);
    const cambios = [];
    for (const tr of d.querySelectorAll('tbody tr')) {
      const leer = (k) => tr.querySelector(`input[name="${k}"]`).value.trim();
      if (leer('capacidad_galones') === '') continue;
      const p = { estacion: t.estacion, producto: tr.dataset.producto, usuario: usuario || undefined };
      for (const c of CAMPOS_TANQUE) {
        const n = Number(leer(c.clave));
        if (leer(c.clave) === '' || !Number.isFinite(n) || n < c.min) {
          tr.querySelector(`input[name="${c.clave}"]`).focus();
          return mensajeModal('aviso', `${tr.dataset.producto}: "${c.titulo}" tiene que ser un número de ${c.min} en adelante.`);
        }
        p[c.clave] = c.clave === 'dias_consumo' ? Math.round(n) : n;
      }
      if (p.nivel_minimo_pct >= p.llenado_maximo_pct) return mensajeModal('aviso', `${tr.dataset.producto}: el mínimo tiene que ser menor que el llenado máximo.`);
      cambios.push(p);
    }
    if (!cambios.length) return mensajeModal('aviso', 'Escribe la capacidad de al menos un combustible.');
    mensajeModal('info', 'Guardando…');
    ocupar(true);
    try {
      for (const p of cambios) {
        await pedir('/api/tanques', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      }
      ocupar(false);
      d.close();
      pendiente = true;
      cargar();
    } catch (err) {
      ocupar(false);
      mensajeModal('critico', err.message);
    }
  });
}

function indicadores(productos) {
  const div = document.createElement('div');
  div.className = 'indicadores';
  div.innerHTML = productos
    .map((p) => {
      const final = finalAjustado(p);
      const valor = final === null ? 'Sin toma física' : fmt.galones(final);
      const nota =
        p.inicial === null
          ? `Movimiento del periodo: ${conSigno(p.compras - p.ventas)}`
          : `Inicial ${fmt.galones(p.inicial)} · compras ${fmt.galones(p.compras)} · ventas ${fmt.galones(p.ventas)}`;
      const ajuste = final - p.final_teorico;
      const toma =
        p.tomas_en_rango && p.final_segun_toma !== null
          ? `Ajustada a la toma del ${fechaHora(p.final_toma_en, false)}${Math.abs(ajuste) >= 0.0005 ? ` (${ajuste < 0 ? 'faltante' : 'sobrante'} ${conSigno(ajuste)})` : ''}`
          : '';
      return `<div class="indicador"><div class="indicador-titulo">${conPunto(p.producto, varProducto(p.producto))} · existencia final</div>
        <div class="indicador-valor num">${escapar(valor)}</div><div class="indicador-nota">${escapar(nota)}</div>${toma ? `<div class="indicador-nota">${escapar(toma)}</div>` : ''}</div>`;
    })
    .join('');
  return div;
}

/** La tabla principal: inicial + compras - ventas = final, por producto */
function movimiento(inv, productos) {
  const sec = document.createElement('section');
  sec.className = 'tarjeta';
  const filas = productos.map((p) => ({
    ...p,
    dif: p.tomas_en_rango && p.final_segun_toma !== null && p.final_teorico !== null ? p.final_segun_toma - p.final_teorico : null,
  }));
  sec.innerHTML = `<div class="tarjeta-cabeza"><div><h3>Movimiento de inventario</h3>
      <p class="tarjeta-sub">${escapar(`${inv.estacion.codigo} · del ${fecha(inv.filtros.desde, true)} al ${fecha(inv.filtros.hasta, true)}. Galones.`)}</p></div></div>
    ${tablaHtml(
      [
        { titulo: 'Producto', valor: (p) => conPunto(p.producto, varProducto(p.producto)), html: true },
        { titulo: 'Existencia inicial', valor: (p) => (p.inicial === null ? 'Sin toma' : fmt.galones(p.inicial)), der: true },
        { titulo: '+ Compras', valor: (p) => `${fmt.galones(p.compras)}${p.facturas ? ` (${plural(p.facturas, 'factura', 'facturas')})` : ''}`, der: true },
        { titulo: '− Ventas', valor: (p) => fmt.galones(p.ventas), der: true },
        { titulo: '= Final calculada', valor: (p) => (p.final_teorico === null ? '–' : fmt.galones(p.final_teorico)), der: true },
        { titulo: 'Ajuste por toma física', valor: (p) => diferencia(p.dif), html: true },
        { titulo: 'Existencia final', valor: (p) => (finalAjustado(p) === null ? '–' : fmt.galones(finalAjustado(p))), der: true },
        { titulo: 'Toma de partida', valor: (p) => (p.inicial_toma_en ? `${fechaHora(p.inicial_toma_en)} · ${fmt.galones(p.inicial_toma_galones)}` : '–'), clase: 'inv-secundaria' },
      ],
      filas,
    )}
    <p class="nota" style="margin-top:8px">La final calculada es inicial + compras − ventas. Si en el periodo hay una toma física, la existencia se ajusta a lo medido: el ajuste negativo es faltante (merma, evaporación, calibración, ventas sin ticket o una compra registrada con otra fecha) y el positivo, sobrante. La existencia final sale de la última toma, más las compras y menos las ventas que vinieron después de ella.</p>`;
  return sec;
}

/**
 * Existencia al cierre de cada día desde la inicial, con las compras y las ventas del día. Cada toma física
 * del rango manda: el día de la toma la existencia se ajusta a lo medido y el ajuste (faltante o sobrante)
 * queda aparte. inv.tomas trae la diferencia de cada toma contra lo calculado desde la inicial, sin ajustes;
 * el ajuste de una toma es esa diferencia menos los ajustes de las tomas anteriores.
 */
function kardex(inv, productos) {
  const filas = [];
  for (const p of productos) {
    if (p.inicial === null) continue;
    const ajustes = new Map(); // fecha -> {ajuste, tomas}
    let yaAjustado = 0;
    for (const m of inv.tomas.filter((x) => x.producto === p.producto && x.diferencia !== null)) {
      const ajuste = m.diferencia - yaAjustado;
      yaAjustado += ajuste;
      const dia = m.fecha_hora.slice(0, 10);
      const a = ajustes.get(dia) ?? { ajuste: 0, tomas: [] };
      a.ajuste += ajuste;
      a.tomas.push({ ...m, ajuste });
      ajustes.set(dia, a);
    }
    let saldo = p.inicial;
    for (const d of inv.diario.filter((x) => x.producto === p.producto)) {
      const inicial = saldo;
      const a = ajustes.get(d.fecha) ?? { ajuste: 0, tomas: [] };
      saldo = saldo + d.compras - d.ventas + a.ajuste;
      filas.push({ fecha: d.fecha, producto: p.producto, inicial, compras: d.compras, ventas: d.ventas, ajuste: a.ajuste, tomas: a.tomas, final: saldo });
    }
  }
  return filas;
}

/** Existencia al final del rango: la calculada, ajustada a la última toma física del rango si hubo */
const finalAjustado = (p) => (p.tomas_en_rango && p.final_segun_toma !== null ? p.final_segun_toma : p.final_teorico);

/**
 * Cascada de un producto: la existencia inicial, y cada día sus compras (suben), sus ventas (bajan) y la
 * existencia al cierre. Un paso de compras solo sale el día que hubo compra, para no llenar el eje de ceros
 */
function cascadaPorDia(inv, productos) {
  const conToma = productos.filter((p) => p.inicial !== null);
  let producto = conToma.some((p) => p.producto === filtros.cascada) ? filtros.cascada : conToma[0]?.producto;
  const t = tarjeta({
    titulo: 'Existencia, compras y ventas por día',
    subtitulo:
      'Cascada: cada día las compras suben la existencia, las ventas la bajan y la barra llena es la existencia al cierre. El día de una toma física, el ajuste (amarillo) la lleva a lo medido. Galones.',
    alto: 340,
    clase: 'col-12',
    controles: conToma.length > 1 ? segmentado('inv-cascada', conToma.map((p) => ({ valor: p.producto, texto: p.producto })), producto) : '',
  });
  if (!producto) {
    t.grafica.vacio('Sin toma física: no se puede calcular la existencia');
    t.ponerTabla('<p class="vacio">Sin toma física: no se puede calcular la existencia</p>');
    return t.el;
  }
  const filas = kardex(inv, productos);
  const dibujar = (nombre) => {
    producto = nombre;
    filtros.cascada = nombre;
    const p = conToma.find((x) => x.producto === nombre);
    const dias = filas.filter((f) => f.producto === nombre);
    const tomasDe = (dia) => inv.tomas.filter((m) => m.producto === nombre && m.fecha_hora.slice(0, 10) === dia);
    const pasos = [
      {
        etiqueta: 'Inicial',
        titulo: `${nombre} · existencia al empezar el ${fecha(inv.filtros.desde, true)}`,
        tipo: 'total',
        antes: 0,
        despues: p.inicial,
        nota: p.inicial_toma_en ? `Calculada desde la toma física del ${fechaHora(p.inicial_toma_en)}` : null,
      },
    ];
    for (const d of dias) {
      const dia = `${diaSemana(d.fecha)} ${fecha(d.fecha, true)}`;
      if (d.compras) pasos.push({ etiqueta: '', titulo: `${nombre} · compras del ${dia}`, tipo: 'sube', antes: d.inicial, despues: d.inicial + d.compras });
      const despuesDeVentas = d.inicial + d.compras - d.ventas;
      pasos.push({ etiqueta: '', titulo: `${nombre} · ventas del ${dia}`, tipo: 'baja', antes: d.inicial + d.compras, despues: despuesDeVentas });
      // El ajuste va al final del día: la existencia al cierre queda igual a la toma más lo que pasó después de ella
      if (d.tomas.length) {
        pasos.push({
          etiqueta: '',
          titulo: `${nombre} · ajuste por toma física del ${dia}`,
          tipo: 'ajuste',
          antes: despuesDeVentas,
          despues: d.final,
          nota: d.tomas
            .map((m) => `Toma de las ${m.fecha_hora.slice(11)}: ${fmt.galones(m.galones)} medidos contra ${fmt.galones(m.galones - m.ajuste)} calculados (${m.ajuste < 0 ? 'faltante' : 'sobrante'} ${conSigno(m.ajuste)})`)
            .join(' · '),
        });
      }
      const tomas = tomasDe(d.fecha);
      pasos.push({
        etiqueta: fecha(d.fecha),
        titulo: `${nombre} · existencia al cierre del ${dia}`,
        tipo: 'total',
        antes: 0,
        despues: d.final,
        nota: tomas.length ? tomas.map((m) => `Toma física a las ${m.fecha_hora.slice(11)}: ${fmt.galones(m.galones)}`).join(' · ') : null,
      });
    }
    cascada(t.grafica, {
      pasos,
      nombres: { total: 'Existencia', sube: 'Compras', baja: 'Ventas', ajuste: 'Ajuste por toma física' },
      colorTotal: (c) => colorProducto(nombre, c),
      formato: fmt.galones,
      formatoEje: fmt.galonesCorto,
    });
    t.ponerTabla(
      tablaHtml(
        [
          { titulo: 'Fecha', valor: (f) => `${diaSemana(f.fecha)} ${fecha(f.fecha, true)}` },
          { titulo: 'Existencia inicial', valor: (f) => fmt.galones(f.inicial), der: true },
          { titulo: '+ Compras', valor: (f) => fmt.galones(f.compras), der: true },
          { titulo: '− Ventas', valor: (f) => fmt.galones(f.ventas), der: true },
          { titulo: 'Ajuste por toma física', valor: (f) => (f.tomas.length ? diferencia(f.ajuste) : ''), html: true },
          { titulo: '= Existencia al cierre', valor: (f) => fmt.galones(f.final), der: true },
        ],
        dias,
      ),
    );
  };
  if (conToma.length > 1) conectarSegmentado(t.el, 'inv-cascada', dibujar);
  dibujar(producto);
  return t.el;
}

function existenciaPorDia(inv, productos) {
  const t = tarjeta({ titulo: 'Existencia al cierre de cada día', subtitulo: 'Desde la existencia inicial, ajustada a cada toma física; los días con toma lo dicen en el tooltip', alto: 300, clase: 'col-7' });
  const filas = kardex(inv, productos);
  const fechas = [...new Set(inv.diario.map((d) => d.fecha))];
  const series = productos
    .filter((p) => p.inicial !== null)
    .map((p) => ({ nombre: p.producto, valores: fechas.map((f) => filas.find((x) => x.fecha === f && x.producto === p.producto)?.final ?? null) }));
  if (!series.length) {
    t.grafica.vacio('Sin toma física: no se puede calcular la existencia');
  } else {
    lineas(t.grafica, {
      categorias: fechas,
      series,
      formato: fmt.galones,
      formatoEje: fmt.galonesCorto,
      etiqueta: (x) => fecha(x),
      titulo: (x) => `${diaSemana(x)} ${fecha(x, true)} · al cierre`,
      nota: (i) => {
        const delDia = inv.tomas.filter((m) => m.fecha_hora.slice(0, 10) === fechas[i]);
        return delDia.length ? delDia.map((m) => `Toma ${m.producto} ${m.fecha_hora.slice(11)}: ${fmt.galones(m.galones)}`).join(' · ') : null;
      },
    });
  }
  t.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Fecha', valor: (f) => `${diaSemana(f.fecha)} ${fecha(f.fecha, true)}` },
        { titulo: 'Producto', valor: (f) => conPunto(f.producto, varProducto(f.producto)), html: true },
        { titulo: 'Inicial', valor: (f) => fmt.galones(f.inicial), der: true },
        { titulo: '+ Compras', valor: (f) => fmt.galones(f.compras), der: true },
        { titulo: '− Ventas', valor: (f) => fmt.galones(f.ventas), der: true },
        { titulo: '= Final', valor: (f) => fmt.galones(f.final), der: true },
      ],
      filas.sort((a, b) => a.fecha.localeCompare(b.fecha)),
      { vacio: 'Sin toma física: no se puede calcular la existencia' },
    ),
  );
  return t.el;
}

function comprasVentasPorDia(inv) {
  const medidas = [
    { valor: 'ventas', texto: 'Ventas' },
    { valor: 'compras', texto: 'Compras' },
  ];
  const t = tarjeta({ titulo: 'Compras y ventas por día', subtitulo: 'Galones por producto', alto: 300, clase: 'col-5', controles: segmentado('inv-medida', medidas, 'ventas') });
  const dibujar = (m) => {
    const { categorias, series } = pivotar(inv.diario, 'fecha', m);
    barrasApiladas(t.grafica, {
      categorias,
      series,
      formato: fmt.galones,
      formatoEje: fmt.galonesCorto,
      etiqueta: (x) => fecha(x),
      titulo: (x) => `${diaSemana(x)} ${fecha(x, true)} · ${m === 'ventas' ? 'Ventas' : 'Compras'}`,
    });
    t.ponerTabla(tablaPivote(categorias, series, (x) => `${diaSemana(x)} ${fecha(x, true)}`, 'Fecha', fmt.galones));
  };
  conectarSegmentado(t.el, 'inv-medida', dibujar);
  dibujar('ventas');
  return t.el;
}

function comprasDelPeriodo(inv) {
  const sec = document.createElement('section');
  sec.className = 'tarjeta';
  const total = inv.compras.reduce((a, k) => ({ galones: a.galones + k.galones, total: a.total + k.total, costo: a.costo + (k.costo ?? 0) }), { galones: 0, total: 0, costo: 0 });
  sec.innerHTML = `<div class="tarjeta-cabeza"><div><h3>Compras de combustible del periodo</h3>
      <p class="tarjeta-sub">${escapar(inv.compras.length ? `${plural(inv.compras.length, 'línea', 'líneas')} · ${fmt.galones(total.galones)} · ${fmt.moneda(total.total)} facturado` : 'Las compras entran con el Reporte de compras en la pestaña Cargar reporte')}</p></div></div>
    ${tablaHtml(
      [
        { titulo: 'Fecha y hora', valor: (k) => (k.esPie ? 'Total' : `<span class="nowrap">${escapar(fechaHora(k.fecha_hora))}</span>`), html: true },
        { titulo: 'Factura', valor: (k) => k.factura ?? '' },
        { titulo: 'Turno', valor: (k) => (k.esPie ? '' : (k.turno ?? '–')), der: true, clase: 'inv-secundaria' },
        { titulo: 'Producto', valor: (k) => (k.esPie ? '' : conPunto(k.producto, varProducto(k.producto))), html: true },
        { titulo: 'Galones', valor: (k) => fmt.numero(k.galones, 3), der: true },
        { titulo: 'Precio', valor: (k) => (k.esPie ? '' : fmt.numero(k.precio, 4)), der: true, clase: 'inv-secundaria' },
        { titulo: 'Total', valor: (k) => fmt.moneda(k.total), der: true },
        { titulo: 'Costo FOB', valor: (k) => fmt.moneda(k.costo), der: true },
        { titulo: 'Costo por galón', valor: (k) => fmt.porGalon(k.esPie ? k.costo / k.galones : k.costo_por_galon), der: true },
        { titulo: 'Proveedor', valor: (k) => (k.esPie ? '' : (k.proveedor ?? '–')), clase: 'inv-secundaria' },
      ],
      inv.compras,
      { vacio: 'Sin compras de combustible en este periodo', pie: inv.compras.length > 1 ? { ...total, esPie: true } : null },
    )}`;
  return sec;
}

function tomasDelPeriodo(inv) {
  const sec = document.createElement('section');
  sec.className = 'tarjeta';
  sec.innerHTML = `<div class="tarjeta-cabeza"><div><h3>Tomas físicas del periodo</h3>
      <p class="tarjeta-sub">Cada medición contra lo que debía haber a esa hora según la existencia inicial, las compras y las ventas.</p></div></div>
    ${tablaHtml(
      [
        { titulo: 'Fecha y hora', valor: (m) => `<span class="nowrap">${escapar(fechaHora(m.fecha_hora))}</span>`, html: true },
        { titulo: 'Producto', valor: (m) => conPunto(m.producto, varProducto(m.producto)), html: true },
        { titulo: 'Medido', valor: (m) => fmt.galones(m.galones), der: true },
        { titulo: 'Debía haber', valor: (m) => (m.teorico === null ? '–' : fmt.galones(m.teorico)), der: true },
        { titulo: 'Diferencia', valor: (m) => diferencia(m.diferencia), html: true },
        { titulo: 'Quién', valor: (m) => m.usuario ?? '–', clase: 'inv-secundaria' },
        { titulo: 'Observaciones', valor: (m) => m.observaciones ?? '', clase: 'inv-secundaria' },
      ],
      inv.tomas,
      { vacio: 'Sin tomas físicas en este periodo' },
    )}`;
  return sec;
}
