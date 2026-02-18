
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  TrendingUp, RefreshCw, AlertCircle, LayoutGrid, Store, MapPin, 
  Loader2, ArrowDownToLine, Calculator, ShieldCheck, ReceiptText, 
  Calendar, ChevronLeft, ChevronRight, AlertTriangle, ArrowRight,
  Clock, Filter, DatabaseZap, SearchSlash
} from 'lucide-react';
import { Venta, OdooSession } from '../types';
import { OdooClient } from '../services/odoo';

interface DashboardProps {
    session: OdooSession | null;
    view?: string;
}

type FilterMode = 'hoy' | 'mes' | 'anio' | 'custom';
type ReportTab = 'consolidado' | 'recepcion' | 'surco';

const Dashboard: React.FC<DashboardProps> = ({ session }) => {
  const [ventasData, setVentasData] = useState<Venta[]>([]); 
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('mes');
  const [activeTab, setActiveTab] = useState<ReportTab>('consolidado');
  const [syncProgress, setSyncProgress] = useState('');
  
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth());
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [customRange, setCustomRange] = useState({
    start: new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA'),
    end: today.toLocaleDateString('en-CA')
  });

  const dateRange = useMemo(() => {
    let start = '';
    let end = '';
    if (filterMode === 'hoy') {
      start = today.toLocaleDateString('en-CA');
      end = start;
    } else if (filterMode === 'mes') {
      start = new Date(selectedYear, selectedMonth, 1).toLocaleDateString('en-CA');
      end = new Date(selectedYear, selectedMonth + 1, 0).toLocaleDateString('en-CA');
    } else if (filterMode === 'anio') {
      start = `${selectedYear}-01-01`;
      end = `${selectedYear}-12-31`;
    } else {
      start = customRange.start;
      end = customRange.end;
    }
    return { start, end };
  }, [filterMode, selectedMonth, selectedYear, customRange]);

  const fetchData = useCallback(async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      setSyncProgress('Iniciando Auditoría...');

      try {
          const client = new OdooClient(session.url, session.db);
          const ctx = { 
            company_id: session.companyId, 
            force_company: session.companyId,
            allowed_company_ids: [session.companyId] 
          };
          
          setSyncProgress('Extrayendo Órdenes...');
          const domain: any[] = [
            ['state', 'in', ['paid', 'done', 'invoiced']], 
            ['date_order', '>=', `${dateRange.start} 00:00:00`],
            ['date_order', '<=', `${dateRange.end} 23:59:59`]
          ];
          if (session.companyId) domain.push(['company_id', '=', session.companyId]);

          const orders = await client.searchRead(session.uid, session.apiKey, 'pos.order', domain, 
            ['date_order', 'config_id', 'lines', 'user_id'], 
            { order: 'date_order desc', context: ctx }
          );

          if (!orders || orders.length === 0) {
              setVentasData([]);
              setLoading(false);
              return;
          }

          setSyncProgress('Analizando Líneas de Venta...');
          const allLineIds = orders.flatMap((o: any) => o.lines || []);
          
          // Intentamos traer purchase_price (costo histórico en la línea si existe pos_margin)
          const linesData = await client.searchRead(session.uid, session.apiKey, 'pos.order.line', 
            [['id', 'in', allLineIds]], 
            ['product_id', 'qty', 'price_subtotal', 'price_subtotal_incl', 'order_id', 'purchase_price'],
            { context: ctx }
          );

          const productIds = Array.from(new Set(linesData.map((l: any) => l.product_id[0])));
          
          setSyncProgress('Sincronizando Propiedades de Costo...');
          // Forzamos contexto para obtener standard_price real de la compañía
          const products = await client.searchRead(
            session.uid, session.apiKey, 'product.product', 
            [['id', 'in', productIds]], 
            ['standard_price', 'categ_id', 'product_tmpl_id'],
            { context: ctx }
          );

          // Si hay 0 en producto, auditamos plantillas
          const zeroCostTmplIds = products
            .filter((p: any) => (p.standard_price || 0) === 0)
            .map((p: any) => p.product_tmpl_id[0]);

          let templateCosts = new Map<number, number>();
          if (zeroCostTmplIds.length > 0) {
            const templates = await client.searchRead(
              session.uid, session.apiKey, 'product.template',
              [['id', 'in', Array.from(new Set(zeroCostTmplIds))]],
              ['standard_price'],
              { context: ctx }
            );
            templates.forEach((t: any) => templateCosts.set(t.id, t.standard_price || 0));
          }
          
          const productMap = new Map<number, { cost: number; cat: string }>();
          products.forEach((p: any) => {
              let cost = p.standard_price || 0;
              if (cost === 0 && templateCosts.has(p.product_tmpl_id[0])) {
                cost = templateCosts.get(p.product_tmpl_id[0]) || 0;
              }
              productMap.set(p.id, { cost, cat: p.categ_id ? p.categ_id[1] : 'S/C' });
          });
          
          const linesByOrder = new Map();
          linesData.forEach((l: any) => {
              const oId = l.order_id[0];
              if (!linesByOrder.has(oId)) linesByOrder.set(oId, []);
              linesByOrder.get(oId).push(l);
          });

          const mapped: Venta[] = orders.flatMap((o: any) => {
              const orderLines = linesByOrder.get(o.id) || [];
              const orderDate = new Date(o.date_order.replace(' ', 'T') + 'Z');
              const sede = o.config_id[1] || 'Caja Central';

              return orderLines.map((l: any) => {
                  const pId = l.product_id[0];
                  const pInfo = productMap.get(pId) || { cost: 0, cat: 'S/C' };
                  
                  // Prioridad de costo: 1. purchase_price (histórico línea), 2. pInfo.cost (maestro)
                  const unitCost = (l.purchase_price && l.purchase_price > 0) ? l.purchase_price : pInfo.cost;
                  
                  const ventaNeta = l.price_subtotal || 0; 
                  const ventaTotal = l.price_subtotal_incl || 0;
                  const costoTotal = unitCost * l.qty;
                  
                  return {
                      fecha: orderDate,
                      sede,
                      compania: session.companyName || '',
                      vendedor: o.user_id[1] || 'Usuario',
                      producto: l.product_id[1],
                      categoria: pInfo.cat,
                      total: ventaTotal, 
                      subtotal: ventaNeta,
                      costo: costoTotal,
                      margen: ventaNeta - costoTotal,
                      margenBruto: ventaTotal - costoTotal,
                      cantidad: l.qty,
                      sesion: '', 
                      metodoPago: '-',
                      margenPorcentaje: ventaNeta > 0 ? (((ventaNeta - costoTotal) / ventaNeta) * 100).toFixed(1) : '0.0'
                  };
              });
          });

          setVentasData(mapped);
          setSyncProgress('Análisis Completado');
      } catch (err: any) {
          setError(`Error de Comunicación: ${err.message}`);
      } finally {
          setLoading(false);
      }
  }, [session, dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const stats = useMemo(() => {
    const filterBySede = (data: Venta[], name: string) => data.filter(v => v.sede.toUpperCase().includes(name.toUpperCase()));
    const dataFC = filterBySede(ventasData, 'FEETCARE').concat(filterBySede(ventasData, 'RECEPCION'));
    const dataSurco = filterBySede(ventasData, 'SURCO');

    const calc = (d: Venta[]) => {
      const vBruta = d.reduce((s, x) => s + x.total, 0);
      const vNeta = d.reduce((s, x) => s + x.subtotal, 0);
      const cost = d.reduce((s, x) => s + x.costo, 0);
      const mNeta = d.reduce((s, x) => s + x.margen, 0);
      const mBruta = d.reduce((s, x) => s + x.margenBruto, 0);
      return { 
        vBruta, vNeta, cost, mNeta, mBruta, 
        rent: vNeta > 0 ? ((mNeta / vNeta) * 100).toFixed(1) : '0.0',
        missingCosts: d.filter(x => x.costo <= 0).length
      };
    };

    return {
      global: calc(ventasData),
      feetcare: calc(dataFC),
      surco: calc(dataSurco),
      dataFC, dataSurco
    };
  }, [ventasData]);

  const currentStats = activeTab === 'recepcion' ? stats.feetcare : activeTab === 'surco' ? stats.surco : stats.global;
  const currentData = activeTab === 'recepcion' ? stats.dataFC : activeTab === 'surco' ? stats.dataSurco : ventasData;

  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  return (
    <div className="p-4 md:p-8 font-sans max-w-7xl mx-auto space-y-8 animate-in fade-in pb-32">
      
      {/* HEADER DE AUDITORÍA */}
      <div className="bg-white p-8 rounded-[3.5rem] shadow-2xl border border-slate-100 space-y-8">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
          <div className="flex items-center gap-4">
             <div className="p-4 bg-slate-900 rounded-3xl shadow-xl"><DatabaseZap className="text-brand-400 w-7 h-7" /></div>
             <div>
                <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tighter italic leading-none">Auditoría Real de Rentabilidad</h1>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 flex items-center gap-2">
                  <ShieldCheck size={12} className="text-emerald-500"/> Integridad de Datos: {currentStats.missingCosts === 0 ? 'Óptima' : `Atención: ${currentStats.missingCosts} productos sin costo`}
                </p>
             </div>
          </div>
          <button onClick={fetchData} disabled={loading} className="w-full lg:w-auto flex items-center justify-center gap-3 bg-brand-500 text-white px-10 py-5 rounded-2xl font-black text-[11px] hover:bg-brand-600 transition-all uppercase tracking-widest shadow-xl shadow-brand-500/20">
             <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Sincronizar Odoo
          </button>
        </div>

        {/* SELECTOR DE TIEMPO */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 p-2 bg-slate-50 rounded-[2.5rem] border border-slate-100">
           <div className="flex bg-white p-1.5 rounded-2xl shadow-inner w-full md:w-auto">
             {(['hoy', 'mes', 'anio', 'custom'] as FilterMode[]).map(m => (
               <button key={m} onClick={() => setFilterMode(m)} className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${filterMode === m ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>
                  {m === 'hoy' ? 'Hoy' : m === 'mes' ? 'Mes' : m === 'anio' ? 'Año' : 'Rango'}
               </button>
             ))}
           </div>

           <div className="flex items-center gap-6 px-8">
              {filterMode === 'mes' && (
                <div className="flex items-center gap-6 animate-in slide-in-from-right-4">
                   <button onClick={() => setSelectedMonth(m => m === 0 ? 11 : m - 1)} className="p-2 hover:bg-white rounded-full transition-all text-slate-400"><ChevronLeft/></button>
                   <span className="text-sm font-black text-slate-900 uppercase italic min-w-[120px] text-center">{meses[selectedMonth]} {selectedYear}</span>
                   <button onClick={() => setSelectedMonth(m => m === 11 ? 0 : m + 1)} className="p-2 hover:bg-white rounded-full transition-all text-slate-400"><ChevronRight/></button>
                </div>
              )}
              {filterMode === 'hoy' && <span className="text-sm font-black text-brand-600 uppercase italic">Venta de Hoy: {today.toLocaleDateString()}</span>}
              {filterMode === 'custom' && (
                 <div className="flex items-center gap-3">
                   <input type="date" value={customRange.start} onChange={e => setCustomRange({...customRange, start: e.target.value})} className="p-2 bg-white border border-slate-200 rounded-xl text-[10px] font-bold" />
                   <ArrowRight size={14} className="text-slate-300"/>
                   <input type="date" value={customRange.end} onChange={e => setCustomRange({...customRange, end: e.target.value})} className="p-2 bg-white border border-slate-200 rounded-xl text-[10px] font-bold" />
                 </div>
              )}
           </div>
        </div>
      </div>

      {/* KPIs DE CUADRE REAL */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm relative overflow-hidden group">
             <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1">Venta de Caja (Bruta)</p>
             <h3 className="text-3xl font-black text-slate-900 tracking-tighter">S/ {currentStats.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[10px] font-bold text-slate-400 mt-2 italic uppercase">Base Neto: S/ {currentStats.vNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</p>
             <div className="absolute top-0 right-0 w-24 h-24 bg-brand-50 rounded-bl-[4rem] flex items-center justify-center -mr-8 -mt-8 opacity-50"><ArrowDownToLine className="text-brand-500 w-6 h-6 ml-2 mt-2" /></div>
          </div>
          <div className={`p-8 rounded-[3rem] border shadow-sm transition-all ${currentStats.missingCosts > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-100'}`}>
             <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><Calculator className="w-3 h-3"/> Costo Total de Ventas</p>
             <h3 className={`text-3xl font-black tracking-tighter ${currentStats.cost === 0 ? 'text-rose-500 animate-pulse' : 'text-slate-900'}`}>S/ {currentStats.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             {currentStats.missingCosts > 0 && (
               <p className="text-[9px] font-black text-amber-600 mt-2 uppercase flex items-center gap-1">
                 <AlertTriangle size={12}/> {currentStats.missingCosts} prod. sin costo en Odoo
               </p>
             )}
          </div>
          <div className="bg-slate-900 p-8 rounded-[3rem] shadow-2xl text-white">
             <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Utilidad Neta (Auditada)</p>
             <h3 className="text-3xl font-black tracking-tighter text-brand-400">S/ {currentStats.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[10px] font-black text-white/30 mt-2 uppercase">Rentabilidad Real: {currentStats.rent}%</p>
          </div>
          <div className="bg-brand-50 p-8 rounded-[3rem] border border-brand-100 shadow-xl shadow-brand-500/5">
             <p className="text-brand-600 text-[10px] font-black uppercase tracking-widest mb-1">Utilidad de Caja (Bruta)</p>
             <h3 className="text-3xl font-black tracking-tighter text-brand-700">S/ {currentStats.mBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[10px] font-bold text-brand-400 mt-2 uppercase">Total para gastos e inversión</p>
          </div>
      </div>

      {/* TABLAS DETALLADAS */}
      <div className="space-y-8">
        <div className="flex bg-slate-100 p-1.5 rounded-full border border-slate-200 gap-2 w-fit mx-auto shadow-inner">
            {(['consolidado', 'recepcion', 'surco'] as ReportTab[]).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-10 py-3.5 rounded-full font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:text-slate-600'}`}>
                {tab === 'consolidado' ? 'Global' : tab === 'recepcion' ? 'FeetCare' : 'Surco'}
              </button>
            ))}
        </div>

        <div className="bg-white rounded-[3rem] border border-slate-200 shadow-2xl overflow-hidden animate-in zoom-in-95">
          <div className="px-10 py-8 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-xl font-black text-slate-900 uppercase tracking-tighter flex items-center gap-3 italic">
              <ReceiptText className="text-brand-500 w-7 h-7" /> Listado Detallado de Auditoría
            </h3>
            {currentStats.missingCosts > 0 && (
              <div className="flex items-center gap-3 bg-amber-100 px-5 py-2.5 rounded-2xl border border-amber-200 animate-pulse">
                <AlertTriangle size={16} className="text-amber-600" />
                <span className="text-[10px] font-black text-amber-700 uppercase">Detectados {currentStats.missingCosts} errores de costo</span>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50/50 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                <tr>
                  <th className="px-10 py-6">Producto / Auditoría de Origen</th>
                  <th className="px-10 py-6 text-right">Venta (Neto)</th>
                  <th className="px-10 py-6 text-right">Costo Auditado</th>
                  <th className="px-10 py-6 text-right">Utilidad Real</th>
                  <th className="px-10 py-6 text-center">Rent %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {currentData.map((v, i) => (
                  <tr key={i} className={`hover:bg-slate-50 transition-all ${v.costo <= 0 ? 'bg-rose-50/40' : ''}`}>
                    <td className="px-10 py-6">
                       <p className="font-black text-slate-900 text-xs uppercase leading-tight">{v.producto}</p>
                       <p className="text-[9px] text-slate-400 font-bold mt-1 uppercase flex items-center gap-1.5">
                         {v.costo <= 0 && <AlertTriangle size={12} className="text-rose-500"/>}
                         {v.fecha.toLocaleDateString('es-PE')} - {v.sede}
                       </p>
                    </td>
                    <td className="px-10 py-6 text-right font-black text-slate-900 text-xs">S/ {v.subtotal.toFixed(2)}</td>
                    <td className={`px-10 py-6 text-right font-bold text-xs ${v.costo <= 0 ? 'text-rose-500 underline decoration-double' : 'text-slate-400 italic'}`}>
                       S/ {v.costo.toFixed(2)}
                    </td>
                    <td className="px-10 py-6 text-right font-black text-brand-600 text-xs">S/ {v.margen.toFixed(2)}</td>
                    <td className="px-10 py-6 text-center">
                       <span className={`text-[10px] font-black px-3 py-1.5 rounded-xl ${Number(v.margenPorcentaje) >= 100 || v.costo <= 0 ? 'bg-rose-100 text-rose-700' : 'bg-brand-50 text-brand-700'}`}>
                          {v.margenPorcentaje}%
                       </span>
                    </td>
                  </tr>
                ))}
                {currentData.length === 0 && (
                  <tr><td colSpan={5} className="px-10 py-32 text-center text-slate-300 font-black uppercase tracking-[0.3em] italic flex items-center justify-center gap-4"> <SearchSlash size={24}/> No hay registros en este periodo </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {loading && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-12 py-6 rounded-[2rem] shadow-2xl flex items-center gap-5 animate-bounce z-50 border border-slate-700">
           <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
           <div className="flex flex-col">
              <span className="text-xs font-black uppercase tracking-widest italic leading-none">{syncProgress}</span>
              <span className="text-[8px] text-slate-500 font-bold uppercase mt-1 tracking-tighter italic">Ingeniería Lemon BI v3.5</span>
           </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 p-10 rounded-[3rem] flex items-center gap-8 text-rose-600 shadow-2xl animate-in slide-in-from-top-12">
          <div className="p-4 bg-rose-100 rounded-3xl"><AlertCircle className="w-10 h-10" /></div>
          <div>
            <p className="font-black text-lg uppercase tracking-tighter mb-1">Error Crítico de Datos</p>
            <p className="text-sm font-medium opacity-80">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
