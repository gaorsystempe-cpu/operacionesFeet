import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  RefreshCw, AlertCircle,
  Loader2, ArrowDownToLine, Calculator, ReceiptText, 
  ChevronLeft, ChevronRight, AlertTriangle,
  DatabaseZap, SearchSlash, Terminal, FileSpreadsheet, X, Download
} from 'lucide-react';
import { Venta, OdooSession } from '../types';
import { OdooClient } from '../services/odoo';
import * as XLSX from 'xlsx';

interface DashboardProps {
    session: OdooSession | null;
    view?: string;
}

type FilterMode = 'hoy' | 'mes' | 'anio' | 'custom';
type ReportTab = 'consolidado' | 'recepcion' | 'surco';

// ─────────────────────────────────────────────────────────────
// ✅ TIMEZONE Lima (UTC-5)
// ─────────────────────────────────────────────────────────────
const getLimaDate = (): Date => {
  const now = new Date();
  const limaOffset = -5 * 60 * 60 * 1000;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  return new Date(utcMs + limaOffset);
};

const limaDateToString = (date: Date): string =>
  date.toLocaleDateString('en-CA');

// ─────────────────────────────────────────────────────────────
// COMPONENTE: Mini calendario para selección de rango
// ─────────────────────────────────────────────────────────────
interface MiniCalendarProps {
  selecting: 'start' | 'end';
  rangeStart: string;
  rangeEnd: string;
  onSelectDay: (dateStr: string) => void;
}

const DIAS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do'];
const MESES_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const MiniCalendar: React.FC<MiniCalendarProps> = ({ selecting, rangeStart, rangeEnd, onSelectDay }) => {
  const today = getLimaDate();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const firstDay = new Date(viewYear, viewMonth, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Monday-based
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1)
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const toStr = (d: number) => {
    const mm = String(viewMonth + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return `${viewYear}-${mm}-${dd}`;
  };

  const isInRange = (d: number) => {
    if (!rangeStart || !rangeEnd) return false;
    const s = toStr(d);
    return s > rangeStart && s < rangeEnd;
  };
  const isStart   = (d: number) => !!rangeStart && toStr(d) === rangeStart;
  const isEnd     = (d: number) => !!rangeEnd   && toStr(d) === rangeEnd;
  const isToday   = (d: number) => toStr(d) === limaDateToString(today);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-4">
        <button onClick={prevMonth} className="p-2 hover:bg-slate-200 rounded-xl transition-all text-slate-500">
          <ChevronLeft size={16}/>
        </button>
        <span className="text-sm font-black text-slate-900 uppercase tracking-tight">
          {MESES_FULL[viewMonth]} {viewYear}
        </span>
        <button onClick={nextMonth} className="p-2 hover:bg-slate-200 rounded-xl transition-all text-slate-500">
          <ChevronRight size={16}/>
        </button>
      </div>

      <div className="grid grid-cols-7 mb-2">
        {DIAS.map(d => (
          <div key={d} className="text-center text-[10px] font-black text-slate-400 uppercase py-1">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const start   = isStart(day);
          const end     = isEnd(day);
          const inRange = isInRange(day);
          const todayMk = isToday(day);
          return (
            <button
              key={i}
              onClick={() => onSelectDay(toStr(day))}
              className={`
                text-[12px] font-bold py-1.5 rounded-lg transition-all w-full
                ${start || end
                  ? 'bg-brand-500 text-white font-black shadow-md'
                  : inRange
                    ? 'bg-brand-100 text-brand-800'
                    : 'hover:bg-slate-200 text-slate-700'}
                ${todayMk && !start && !end ? 'ring-2 ring-brand-400 ring-offset-1' : ''}
              `}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// COMPONENTE: Modal de exportación con selector de rango
// ─────────────────────────────────────────────────────────────
interface ExportModalProps {
  onClose: () => void;
  onExport: (start: string, end: string, label: string) => void;
  allData: Venta[];
}

const ExportModal: React.FC<ExportModalProps> = ({ onClose, onExport, allData }) => {
  const today      = getLimaDate();
  const todayStr   = limaDateToString(today);
  const yesterdayStr = limaDateToString(new Date(today.getTime() - 86400000));

  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd,   setRangeEnd]   = useState('');
  const [selecting,  setSelecting]  = useState<'start' | 'end'>('start');

  const quickSets = [
    { label: 'Hoy',    start: todayStr,     end: todayStr },
    { label: 'Ayer',   start: yesterdayStr, end: yesterdayStr },
    {
      label: 'Esta semana',
      start: (() => {
        const d = new Date(today);
        d.setDate(d.getDate() - (d.getDay() + 6) % 7);
        return limaDateToString(d);
      })(),
      end: todayStr
    },
    {
      label: 'Este mes',
      start: `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`,
      end: todayStr
    },
    {
      label: 'Mes anterior',
      start: limaDateToString(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      end:   limaDateToString(new Date(today.getFullYear(), today.getMonth(), 0))
    },
  ];

  const handleSelectDay = (dateStr: string) => {
    if (selecting === 'start') {
      setRangeStart(dateStr);
      setRangeEnd('');
      setSelecting('end');
    } else {
      if (dateStr < rangeStart) {
        setRangeEnd(rangeStart);
        setRangeStart(dateStr);
      } else {
        setRangeEnd(dateStr);
      }
      setSelecting('start');
    }
  };

  const handleQuick = (start: string, end: string) => {
    setRangeStart(start);
    setRangeEnd(end);
    setSelecting('start');
  };

  const filteredCount = useMemo(() => {
    if (!rangeStart || !rangeEnd) return 0;
    return allData.filter(v => {
      const ds = limaDateToString(v.fecha);
      return ds >= rangeStart && ds <= rangeEnd;
    }).length;
  }, [allData, rangeStart, rangeEnd]);

  const rangeLabel = rangeStart && rangeEnd
    ? rangeStart === rangeEnd ? rangeStart : `${rangeStart} → ${rangeEnd}`
    : rangeStart ? `Desde ${rangeStart}…` : 'Sin selección';

  const canExport = !!(rangeStart && rangeEnd && filteredCount > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm">
      <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-xl overflow-hidden animate-in fade-in slide-in-from-bottom-8">

        {/* Header */}
        <div className="bg-slate-900 px-10 py-7 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-brand-500/20 rounded-2xl">
              <FileSpreadsheet className="w-6 h-6 text-brand-400" />
            </div>
            <div>
              <h2 className="text-lg font-black text-white uppercase tracking-tighter">Exportar Excel</h2>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Selecciona el rango de fechas</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-all text-slate-400 hover:text-white">
            <X size={20}/>
          </button>
        </div>

        <div className="p-8 space-y-5">

          {/* Accesos rápidos */}
          <div>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Acceso Rápido</p>
            <div className="flex flex-wrap gap-2">
              {quickSets.map(q => (
                <button
                  key={q.label}
                  onClick={() => handleQuick(q.start, q.end)}
                  className={`px-5 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-wide transition-all border
                    ${rangeStart === q.start && rangeEnd === q.end
                      ? 'bg-brand-500 text-white border-brand-500 shadow-md shadow-brand-500/30'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-brand-400 hover:text-brand-600'}`}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {/* Indicadores inicio / fin */}
          <div className="flex gap-3">
            <div
              onClick={() => setSelecting('start')}
              className={`flex-1 p-4 rounded-2xl border-2 cursor-pointer transition-all
                ${selecting === 'start' ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}
            >
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">📅 Fecha Inicio</p>
              <p className={`text-sm font-black ${rangeStart ? 'text-slate-900' : 'text-slate-300'}`}>
                {rangeStart || 'Toca un día…'}
              </p>
            </div>
            <div className="flex items-center text-slate-300 font-black text-xl select-none">→</div>
            <div
              onClick={() => rangeStart && setSelecting('end')}
              className={`flex-1 p-4 rounded-2xl border-2 cursor-pointer transition-all
                ${selecting === 'end' ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}
            >
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">🏁 Fecha Fin</p>
              <p className={`text-sm font-black ${rangeEnd ? 'text-slate-900' : 'text-slate-300'}`}>
                {rangeEnd || 'Toca un día…'}
              </p>
            </div>
          </div>

          {/* Instrucción dinámica */}
          <p className="text-[11px] font-black text-brand-600 uppercase tracking-widest text-center">
            {selecting === 'start'
              ? '👆 Selecciona el día de INICIO en el calendario'
              : '👆 Ahora selecciona el día de FIN'}
          </p>

          {/* Calendario */}
          <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100">
            <MiniCalendar
              selecting={selecting}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onSelectDay={handleSelectDay}
            />
          </div>

          {/* Pie modal: resumen + botón */}
          <div className="flex items-center justify-between bg-slate-900 rounded-2xl px-8 py-5">
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Período</p>
              <p className="text-sm font-black text-white mt-0.5">{rangeLabel}</p>
              {rangeStart && rangeEnd && (
                <p className={`text-[10px] font-bold mt-1 ${filteredCount > 0 ? 'text-brand-400' : 'text-rose-400'}`}>
                  {filteredCount > 0 ? `${filteredCount} registros` : 'Sin registros en este rango'}
                </p>
              )}
            </div>
            <button
              onClick={() => canExport && onExport(rangeStart, rangeEnd, rangeLabel)}
              disabled={!canExport}
              className="flex items-center gap-3 bg-brand-500 text-white px-8 py-4 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-brand-600 transition-all shadow-lg shadow-brand-500/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
            >
              <Download size={16}/> Descargar
            </button>
          </div>

        </div>
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL: Dashboard
// ─────────────────────────────────────────────────────────────
const Dashboard: React.FC<DashboardProps> = ({ session }) => {
  const [ventasData, setVentasData] = useState<Venta[]>([]); 
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('mes');
  const [activeTab, setActiveTab] = useState<ReportTab>('consolidado');
  const [syncProgress, setSyncProgress] = useState('');
  const [showExportModal, setShowExportModal] = useState(false);
  
  const today = getLimaDate();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth());
  const [selectedYear,  setSelectedYear]  = useState(today.getFullYear());
  const [customRange, setCustomRange] = useState({
    start: new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA'),
    end:   limaDateToString(today)
  });

  const dateRange = useMemo(() => {
    let start = '', end = '';
    if (filterMode === 'hoy') {
      start = limaDateToString(getLimaDate());
      end = start;
    } else if (filterMode === 'mes') {
      start = new Date(selectedYear, selectedMonth, 1).toLocaleDateString('en-CA');
      end   = new Date(selectedYear, selectedMonth + 1, 0).toLocaleDateString('en-CA');
    } else if (filterMode === 'anio') {
      start = `${selectedYear}-01-01`;
      end   = `${selectedYear}-12-31`;
    } else {
      start = customRange.start;
      end   = customRange.end;
    }
    return { start, end };
  }, [filterMode, selectedMonth, selectedYear, customRange]);

  const fetchData = useCallback(async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      setSyncProgress('Autenticando Odoo 14...');
      try {
          const client = new OdooClient(session.url, session.db);
          const odooContext = { 
            company_id: session.companyId, 
            force_company: session.companyId,
            allowed_company_ids: [session.companyId],
            pricelist: 1 
          };
          setSyncProgress('Extrayendo Pedidos...');
          // ✅ TIMEZONE CORREGIDO: Lima = UTC-5
          const domain: any[] = [
            ['state', 'in', ['paid', 'done', 'invoiced']], 
            ['date_order', '>=', `${dateRange.start} 05:00:00`],
            ['date_order', '<=', `${dateRange.end} 04:59:59`]
          ];
          if (session.companyId) domain.push(['company_id', '=', session.companyId]);

          const orders = await client.searchRead(session.uid, session.apiKey, 'pos.order', domain, 
            ['date_order', 'config_id', 'lines', 'user_id'], 
            { order: 'date_order desc', context: odooContext }
          );

          if (!orders || orders.length === 0) {
              setVentasData([]);
              setSyncProgress('Sin ventas encontradas');
              setLoading(false);
              return;
          }

          setSyncProgress(`Analizando ${orders.length} pedidos...`);
          const allLineIds = orders.flatMap((o: any) => o.lines || []);
          const linesData = await client.searchRead(session.uid, session.apiKey, 'pos.order.line', 
            [['id', 'in', allLineIds]], 
            ['product_id', 'qty', 'price_subtotal', 'price_subtotal_incl', 'order_id'],
            { context: odooContext }
          );

          const productIds = Array.from(new Set(linesData.map((l: any) => l.product_id[0])));
          setSyncProgress('Recuperando Costos Reales...');
          const products = await client.searchRead(
            session.uid, session.apiKey, 'product.product', 
            [['id', 'in', productIds]], 
            ['standard_price', 'categ_id', 'product_tmpl_id'],
            { context: odooContext }
          );

          const zeroCostTmplIds = products
            .filter((p: any) => (p.standard_price || 0) === 0)
            .map((p: any) => p.product_tmpl_id[0]);

          let templateCosts = new Map<number, number>();
          if (zeroCostTmplIds.length > 0) {
            setSyncProgress('Auditando Plantillas...');
            const templates = await client.searchRead(
              session.uid, session.apiKey, 'product.template',
              [['id', 'in', Array.from(new Set(zeroCostTmplIds))]],
              ['standard_price'],
              { context: odooContext }
            );
            templates.forEach((t: any) => templateCosts.set(t.id, t.standard_price || 0));
          }
          
          const productMap = new Map<number, { cost: number; cat: string }>();
          products.forEach((p: any) => {
              let cost = p.standard_price || 0;
              if (cost === 0 && templateCosts.has(p.product_tmpl_id[0])) {
                cost = templateCosts.get(p.product_tmpl_id[0]) || 0;
              }
              productMap.set(p.id, { cost, cat: Array.isArray(p.categ_id) ? p.categ_id[1] : 'S/C' });
          });
          
          const linesByOrder = new Map();
          linesData.forEach((l: any) => {
              const oId = l.order_id[0];
              if (!linesByOrder.has(oId)) linesByOrder.set(oId, []);
              linesByOrder.get(oId).push(l);
          });

          const mapped: Venta[] = orders.flatMap((o: any) => {
              const orderLines = linesByOrder.get(o.id) || [];
              // ✅ Convertir date_order (UTC) a hora Lima
              const orderDateUTC = new Date(o.date_order.replace(' ', 'T') + 'Z');
              const orderDate    = new Date(orderDateUTC.getTime() - 5 * 60 * 60 * 1000);
              const sede = Array.isArray(o.config_id) ? o.config_id[1] : 'Caja Central';
              return orderLines.map((l: any) => {
                  const pInfo    = productMap.get(l.product_id[0]) || { cost: 0, cat: 'S/C' };
                  const ventaNeta  = l.price_subtotal || 0; 
                  const ventaTotal = l.price_subtotal_incl || 0;
                  const costoTotal = pInfo.cost * l.qty;
                  return {
                      fecha: orderDate,
                      sede,
                      compania: session.companyName || '',
                      vendedor: Array.isArray(o.user_id) ? o.user_id[1] : 'Usuario',
                      producto: Array.isArray(l.product_id) ? l.product_id[1] : 'Producto',
                      categoria: pInfo.cat,
                      total: ventaTotal, 
                      subtotal: ventaNeta,
                      costo: costoTotal,
                      margen: ventaNeta - costoTotal,
                      margenBruto: ventaTotal - costoTotal,
                      cantidad: l.qty,
                      sesion: '', 
                      metodoPago: 'Efectivo',
                      margenPorcentaje: ventaNeta > 0 ? (((ventaNeta - costoTotal) / ventaNeta) * 100).toFixed(1) : '0.0'
                  };
              });
          });

          setVentasData(mapped);
          setSyncProgress('Sincronización Completa');
      } catch (err: any) {
          setError(err.message);
      } finally {
          setLoading(false);
      }
  }, [session, dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const stats = useMemo(() => {
    const filterBySede = (data: Venta[], name: string) =>
      data.filter(v => v.sede.toUpperCase().includes(name.toUpperCase()));
    const dataFC    = filterBySede(ventasData, 'FEETCARE').concat(filterBySede(ventasData, 'RECEPCION'));
    const dataSurco = filterBySede(ventasData, 'SURCO');

    const calc = (d: Venta[]) => {
      const vBruta = d.reduce((s, x) => s + x.total, 0);
      const vNeta  = d.reduce((s, x) => s + x.subtotal, 0);
      const cost   = d.reduce((s, x) => s + x.costo, 0);
      const mNeta  = d.reduce((s, x) => s + x.margen, 0);
      const mBruta = d.reduce((s, x) => s + x.margenBruto, 0);
      const items  = d.reduce((s, x) => s + x.cantidad, 0);
      return { vBruta, vNeta, cost, mNeta, mBruta, items,
        rent: vNeta > 0 ? ((mNeta / vNeta) * 100).toFixed(1) : '0.0',
        missingCosts: d.filter(x => x.costo <= 0).length };
    };
    return { global: calc(ventasData), feetcare: calc(dataFC), surco: calc(dataSurco), dataFC, dataSurco };
  }, [ventasData]);

  // ─────────────────────────────────────────────────────────────
  // Exportar con el rango elegido en el modal
  // ─────────────────────────────────────────────────────────────
  const handleExport = (start: string, end: string, label: string) => {
    const filtered = ventasData.filter(v => {
      const ds = limaDateToString(v.fecha);
      return ds >= start && ds <= end;
    });

    const byS = (data: Venta[], name: string) =>
      data.filter(v => v.sede.toUpperCase().includes(name.toUpperCase()));
    const dataFC    = byS(filtered, 'FEETCARE').concat(byS(filtered, 'RECEPCION'));
    const dataSurco = byS(filtered, 'SURCO');

    const cs = (d: Venta[]) => {
      const vB = d.reduce((s,x) => s+x.total, 0);
      const vN = d.reduce((s,x) => s+x.subtotal, 0);
      const co = d.reduce((s,x) => s+x.costo, 0);
      const mN = d.reduce((s,x) => s+x.margen, 0);
      const it = d.reduce((s,x) => s+x.cantidad, 0);
      return { vB, vN, co, mN, it, rent: vN>0 ? ((mN/vN)*100).toFixed(1) : '0.0' };
    };
    const sg = cs(filtered), sf = cs(dataFC), ss = cs(dataSurco);

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['LEMON BI ANALYTICS — REPORTE DE VENTAS Y RENTABILIDAD'],
      [`PERÍODO: ${label.toUpperCase()}`],
      [],
      ['TOTAL VENTAS (CON IGV)', 'TOTAL VENTAS (SIN IGV)', 'GANANCIA REAL AUDITADA'],
      [sg.vB, sg.vN, sg.mN],
      [],
      ['SEDE','ÍTEMS','VENTA C/IGV','VENTA S/IGV','COSTO TOTAL','UTILIDAD','RENT %','TICKET PROM'],
      ['SEDE SURCO',   ss.it, ss.vB, ss.vN, ss.co, ss.mN, ss.rent+'%', ss.vB/(ss.it||1)],
      ['SEDE FEETCARE',sf.it, sf.vB, sf.vN, sf.co, sf.mN, sf.rent+'%', sf.vB/(sf.it||1)],
      ['TOTAL GENERAL',sg.it, sg.vB, sg.vN, sg.co, sg.mN, sg.rent+'%', sg.vB/(sg.it||1)],
    ]), 'Resumen General');

    const sedeSheet = (name: string, data: Venta[], s: any) => XLSX.utils.aoa_to_sheet([
      [`LEMON BI — REPORTE DETALLADO ${name.toUpperCase()} | ${label.toUpperCase()}`],
      ['SEDE','ÍTEMS','VENTA C/IGV','VENTA S/IGV','COSTO TOTAL','UTILIDAD','RENT %','TICKET PROM'],
      [name, s.it, s.vB, s.vN, s.co, s.mN, s.rent+'%', s.vB/(s.it||1)],
      [],
      ['PRODUCTO / SERVICIO','FECHA','MÉTODO PAGO','MONTO S/IGV','COSTO (ODOO)','UTILIDAD','RENT %','MONTO C/IGV'],
      ...data.map(v => [v.producto, v.fecha.toLocaleDateString('es-PE'), v.metodoPago,
                        v.subtotal, v.costo, v.margen, v.margenPorcentaje+'%', v.total])
    ]);
    XLSX.utils.book_append_sheet(wb, sedeSheet('SURCO',   dataSurco, ss), 'Surco');
    XLSX.utils.book_append_sheet(wb, sedeSheet('FEETCARE',dataFC,    sf), 'Feetcare');

    const pm = new Map<string, any>();
    filtered.forEach(v => {
      if (!pm.has(v.producto)) pm.set(v.producto, { cant:0, vN:0, co:0, mN:0 });
      const c = pm.get(v.producto);
      c.cant += v.cantidad; c.vN += v.subtotal; c.co += v.costo; c.mN += v.margen;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      [`ANÁLISIS POR PRODUCTO | ${label.toUpperCase()}`],
      ['PRODUCTO / SERVICIO','VECES VENDIDO','INGRESO S/IGV','COSTO TOTAL','UTILIDAD','RENT %','PRECIO PROM'],
      ...Array.from(pm.entries()).map(([n, s]) => [
        n, s.cant, s.vN, s.co, s.mN,
        (s.vN>0 ? (s.mN/s.vN*100).toFixed(1) : '0')+'%', s.vN/(s.cant||1)
      ]),
    ]), 'Por Producto');

    const fileLabel = label.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    XLSX.writeFile(wb, `LEMON_BI_${fileLabel}.xlsx`);
    setShowExportModal(false);
  };

  const currentStats = activeTab === 'recepcion' ? stats.feetcare : activeTab === 'surco' ? stats.surco : stats.global;
  const currentData  = activeTab === 'recepcion' ? stats.dataFC   : activeTab === 'surco' ? stats.dataSurco : ventasData;
  const mesesStr = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  return (
    <div className="p-4 md:p-8 font-sans max-w-7xl mx-auto space-y-8 animate-in fade-in pb-32">

      {/* ✅ MODAL EXPORTAR */}
      {showExportModal && (
        <ExportModal
          onClose={() => setShowExportModal(false)}
          onExport={handleExport}
          allData={ventasData}
        />
      )}
      
      {/* HEADER */}
      <div className="bg-white p-8 rounded-[3rem] shadow-2xl border border-slate-100 space-y-8">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
          <div className="flex items-center gap-4">
             <div className="p-4 bg-slate-900 rounded-3xl shadow-xl shadow-brand-500/10">
               <DatabaseZap className="text-brand-400 w-8 h-8" />
             </div>
             <div>
                <h1 className="text-4xl font-black text-slate-900 uppercase tracking-tighter italic leading-none">
                  Lemon BI <span className="text-brand-500">Analytics</span>
                </h1>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 flex items-center gap-2">
                  <Terminal size={12} className="text-brand-500"/> Inteligencia de Negocio Podológico
                </p>
             </div>
          </div>
          <div className="flex flex-wrap gap-3 w-full lg:w-auto">
            {/* ✅ Abre modal de exportación */}
            <button
              onClick={() => setShowExportModal(true)}
              disabled={ventasData.length === 0}
              className="flex-1 lg:flex-none flex items-center justify-center gap-3 bg-slate-900 text-white px-8 py-5 rounded-2xl font-black text-xs hover:bg-slate-800 transition-all uppercase tracking-widest shadow-xl shadow-slate-900/10 disabled:opacity-50"
            >
               <FileSpreadsheet className="w-5 h-5 text-emerald-400" /> Exportar Excel
            </button>
            <button
              onClick={fetchData}
              disabled={loading}
              className="flex-1 lg:flex-none flex items-center justify-center gap-3 bg-brand-500 text-white px-8 py-5 rounded-2xl font-black text-xs hover:bg-brand-600 transition-all uppercase tracking-widest shadow-xl shadow-brand-500/20"
            >
               <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Sincronizar
            </button>
          </div>
        </div>

        {/* FILTROS PANTALLA */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 p-2 bg-slate-50 rounded-[2.5rem] border border-slate-100">
           <div className="flex bg-white p-1.5 rounded-2xl shadow-inner w-full md:w-auto">
             {(['hoy', 'mes', 'anio', 'custom'] as FilterMode[]).map(m => (
               <button key={m} onClick={() => setFilterMode(m)}
                 className={`px-8 py-3.5 rounded-xl text-[10px] font-black uppercase transition-all
                   ${filterMode === m ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>
                  {m === 'hoy' ? 'HOY' : m === 'mes' ? 'MES' : m === 'anio' ? 'AÑO' : 'RANGO'}
               </button>
             ))}
           </div>
           <div className="flex items-center gap-6 px-10">
              {filterMode === 'mes' && (
                <div className="flex items-center gap-8">
                   <button onClick={() => setSelectedMonth(m => m === 0 ? 11 : m - 1)} className="p-2 hover:bg-white rounded-full transition-all text-slate-400"><ChevronLeft/></button>
                   <span className="text-sm font-black text-slate-900 uppercase italic min-w-[140px] text-center">{mesesStr[selectedMonth]} {selectedYear}</span>
                   <button onClick={() => setSelectedMonth(m => m === 11 ? 0 : m + 1)} className="p-2 hover:bg-white rounded-full transition-all text-slate-400"><ChevronRight/></button>
                </div>
              )}
              {filterMode === 'hoy' && (
                <span className="text-sm font-black text-brand-600 uppercase italic">
                  Fecha: {limaDateToString(getLimaDate())}
                </span>
              )}
           </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm relative overflow-hidden">
             <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1 flex items-center gap-2">
               <ArrowDownToLine className="w-3 h-3"/> Venta Bruta (Con IGV)
             </p>
             <h3 className="text-4xl font-black text-slate-900 tracking-tighter">
               S/ {currentStats.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}
             </h3>
          </div>
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm">
             <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1 flex items-center gap-2">
               <Calculator className="w-3 h-3"/> Inversión / Costo Total
             </p>
             <h3 className={`text-4xl font-black tracking-tighter ${currentStats.cost === 0 ? 'text-rose-500' : 'text-slate-900'}`}>
               S/ {currentStats.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}
             </h3>
             {currentStats.missingCosts > 0 && (
               <p className="text-[9px] font-black text-rose-600 mt-2 uppercase flex items-center gap-1.5 animate-pulse">
                 <AlertTriangle size={12}/> {currentStats.missingCosts} productos sin costo
               </p>
             )}
          </div>
          <div className="bg-slate-900 p-8 rounded-[3rem] shadow-2xl text-white">
             <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Ganancia Neta Auditada</p>
             <h3 className="text-4xl font-black tracking-tighter text-brand-400">
               S/ {currentStats.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}
             </h3>
             <p className="text-[10px] font-black text-white/30 mt-2 uppercase">Rentabilidad Media: {currentStats.rent}%</p>
          </div>
          <div className="bg-emerald-600 p-8 rounded-[3rem] shadow-xl shadow-emerald-600/20 text-white">
             <p className="text-white/70 text-[10px] font-black uppercase tracking-widest mb-1">Items Totales</p>
             <h3 className="text-4xl font-black tracking-tighter">{currentStats.items}</h3>
             <p className="text-[10px] font-bold text-white/50 mt-2 uppercase">Servicios y Productos</p>
          </div>
      </div>

      {/* TABLA */}
      <div className="space-y-8">
        <div className="flex bg-slate-100 p-1.5 rounded-full border border-slate-200 gap-2 w-fit mx-auto shadow-inner">
            {(['consolidado', 'recepcion', 'surco'] as ReportTab[]).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-12 py-4 rounded-full font-black text-[10px] uppercase tracking-widest transition-all
                  ${activeTab === tab ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:text-slate-600'}`}>
                {tab === 'consolidado' ? 'Global' : tab === 'recepcion' ? 'FeetCare' : 'Surco'}
              </button>
            ))}
        </div>

        <div className="bg-white rounded-[3rem] border border-slate-200 shadow-2xl overflow-hidden">
          <div className="px-12 py-10 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tighter flex items-center gap-3 italic">
              <ReceiptText className="text-brand-500 w-8 h-8" /> Auditoría de Línea por Producto
            </h3>
            <div className="px-5 py-2.5 bg-white border border-slate-200 rounded-2xl shadow-sm text-right">
               <span className="text-[9px] font-black text-slate-400 uppercase block leading-none mb-1">Registros Locales</span>
               <span className="text-lg font-black text-slate-900 leading-none">{currentData.length}</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50/50 text-[11px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                <tr>
                  <th className="px-12 py-8">Producto / Categoría</th>
                  <th className="px-12 py-8 text-right">Venta C/IGV</th>
                  <th className="px-12 py-8 text-right">Costo Unit.</th>
                  <th className="px-12 py-8 text-right">Utilidad</th>
                  <th className="px-12 py-8 text-center">Rent %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {currentData.map((v, i) => (
                  <tr key={i} className={`hover:bg-slate-50 transition-all ${v.costo <= 0 ? 'bg-rose-50/30' : ''}`}>
                    <td className="px-12 py-6">
                       <p className="font-black text-slate-900 text-[12px] uppercase leading-tight">{v.producto}</p>
                       <p className="text-[9px] text-slate-400 font-bold mt-1.5 uppercase flex items-center gap-2 tracking-tighter">
                         {v.fecha.toLocaleDateString('es-PE')} <span className="text-slate-200">|</span>
                         {v.sede} <span className="text-slate-200">|</span> {v.categoria}
                       </p>
                    </td>
                    <td className="px-12 py-6 text-right font-black text-slate-900 text-sm">S/ {v.total.toFixed(2)}</td>
                    <td className={`px-12 py-6 text-right font-bold text-sm ${v.costo <= 0 ? 'text-rose-500' : 'text-slate-300 italic'}`}>
                       S/ {(v.costo / (v.cantidad || 1)).toFixed(2)}
                    </td>
                    <td className="px-12 py-6 text-right font-black text-brand-600 text-sm bg-brand-50/10">S/ {v.margen.toFixed(2)}</td>
                    <td className="px-12 py-6 text-center">
                       <span className={`text-[10px] font-black px-4 py-2 rounded-xl
                         ${Number(v.margenPorcentaje) >= 100 || v.costo <= 0
                           ? 'bg-rose-100 text-rose-700' : 'bg-brand-50 text-brand-700'}`}>
                          {v.margenPorcentaje}%
                       </span>
                    </td>
                  </tr>
                ))}
                {currentData.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-12 py-40 text-center text-slate-300 font-black uppercase tracking-[0.4em] italic">
                      <SearchSlash size={32} className="inline mb-2 mr-3"/> Sin datos en el periodo
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {loading && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-12 py-6 rounded-3xl shadow-2xl flex items-center gap-6 animate-bounce z-50 border border-slate-700">
           <Loader2 className="w-7 h-7 animate-spin text-brand-500" />
           <div className="flex flex-col">
              <span className="text-xs font-black uppercase tracking-widest italic leading-none">{syncProgress}</span>
              <span className="text-[8px] text-slate-500 font-bold uppercase mt-1 tracking-tighter">API V14 XML-RPC GATEWAY</span>
           </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 p-12 rounded-[3.5rem] flex items-center gap-10 text-rose-600 shadow-2xl animate-in slide-in-from-top-12">
          <div className="p-5 bg-rose-100 rounded-3xl"><AlertCircle className="w-12 h-12" /></div>
          <div className="max-w-xl">
            <p className="font-black text-2xl uppercase tracking-tighter mb-2">Error Crítico Odoo 14</p>
            <p className="text-sm font-medium opacity-90 leading-relaxed font-mono bg-white p-4 rounded-2xl border border-rose-100 overflow-x-auto">{error}</p>
            <button onClick={fetchData} className="mt-6 px-8 py-3 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-700 transition-colors">
              Reintentar Conexión
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
