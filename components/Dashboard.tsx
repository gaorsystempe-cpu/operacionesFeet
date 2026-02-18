
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  TrendingUp, RefreshCw, AlertCircle, FileSpreadsheet, 
  LayoutGrid, Store, MapPin, Loader2, ArrowDownToLine, 
  Calculator, Target, ShieldCheck, ReceiptText, 
  Calendar, ChevronLeft, ChevronRight, AlertTriangle, ArrowRight,
  Clock, Filter
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

const Dashboard: React.FC<DashboardProps> = ({ session }) => {
  const [ventasData, setVentasData] = useState<Venta[]>([]); 
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('mes');
  const [activeTab, setActiveTab] = useState<ReportTab>('consolidado');
  const [syncProgress, setSyncProgress] = useState('');
  
  // Gestión de Tiempo
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth());
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [customRange, setCustomRange] = useState({
    start: new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA'),
    end: today.toLocaleDateString('en-CA')
  });

  // Cálculo de Rango de Fechas para Odoo
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
      setSyncProgress('Autenticando...');

      try {
          const client = new OdooClient(session.url, session.db);
          const odooUid = session.uid;
          const odooKey = session.apiKey;
          
          setSyncProgress(`Extrayendo ventas (${dateRange.start})...`);
          const domain: any[] = [
            ['state', 'in', ['paid', 'done', 'invoiced']], 
            ['date_order', '>=', `${dateRange.start} 00:00:00`],
            ['date_order', '<=', `${dateRange.end} 23:59:59`]
          ];
          if (session.companyId) domain.push(['company_id', '=', session.companyId]);

          const orders = await client.searchRead(odooUid, odooKey, 'pos.order', domain, 
            ['date_order', 'config_id', 'lines', 'amount_total', 'user_id'], 
            { order: 'date_order desc', limit: 4000 }
          );

          if (!orders || orders.length === 0) {
              setVentasData([]);
              setSyncProgress('Sin ventas');
              setLoading(false);
              return;
          }

          setSyncProgress('Cargando líneas y productos...');
          const allLineIds = orders.flatMap((o: any) => o.lines || []);
          const linesData = await client.searchRead(odooUid, odooKey, 'pos.order.line', [['id', 'in', allLineIds]], 
                ['product_id', 'qty', 'price_subtotal', 'price_subtotal_incl', 'order_id']);

          const productIds = Array.from(new Set(linesData.map((l: any) => l.product_id[0])));
          
          setSyncProgress('Sincronizando Costos Reales...');
          // Obtenemos standard_price y product_tmpl_id para asegurar que no falte costo
          const products = await client.searchRead(
            odooUid, odooKey, 'product.product', 
            [['id', 'in', productIds]], 
            ['standard_price', 'categ_id', 'product_tmpl_id'],
            { context: { company_id: session.companyId, force_company: session.companyId } }
          );

          // Si hay costos en 0, intentamos buscar en el template (plantilla de producto)
          const zeroCostTmplIds = products
            .filter((p: any) => (p.standard_price || 0) === 0)
            .map((p: any) => p.product_tmpl_id[0]);

          let templateCosts = new Map<number, number>();
          if (zeroCostTmplIds.length > 0) {
            setSyncProgress('Auditando costos maestros...');
            const templates = await client.searchRead(
              odooUid, odooKey, 'product.template',
              [['id', 'in', Array.from(new Set(zeroCostTmplIds))]],
              ['standard_price'],
              { context: { company_id: session.companyId } }
            );
            templates.forEach((t: any) => templateCosts.set(t.id, t.standard_price || 0));
          }
          
          const productMap = new Map<number, { cost: number; cat: string }>();
          products.forEach((p: any) => {
              let finalCost = p.standard_price || 0;
              // Fallback al costo del template si el de la variante es 0
              if (finalCost === 0 && templateCosts.has(p.product_tmpl_id[0])) {
                finalCost = templateCosts.get(p.product_tmpl_id[0]) || 0;
              }
              productMap.set(p.id, { 
                cost: finalCost, 
                cat: p.categ_id ? p.categ_id[1] : 'S/C' 
              });
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
                  const ventaNeta = l.price_subtotal || 0; 
                  const ventaTotal = l.price_subtotal_incl || 0;
                  const costoTotalLinea = pInfo.cost * l.qty;
                  
                  return {
                      fecha: orderDate,
                      sede,
                      compania: session.companyName || '',
                      vendedor: o.user_id[1] || 'Usuario',
                      producto: l.product_id[1],
                      categoria: pInfo.cat,
                      total: ventaTotal, 
                      subtotal: ventaNeta,
                      costo: costoTotalLinea,
                      margen: ventaNeta - costoTotalLinea,
                      margenBruto: ventaTotal - costoTotalLinea,
                      cantidad: l.qty,
                      sesion: '', 
                      metodoPago: '-',
                      margenPorcentaje: ventaNeta > 0 ? (((ventaNeta - costoTotalLinea) / ventaNeta) * 100).toFixed(1) : '0.0'
                  };
              });
          });

          setVentasData(mapped);
          setSyncProgress('¡Datos cuadrados!');
      } catch (err: any) {
          setError(`Error Odoo: ${err.message}`);
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
        items: d.length
      };
    };

    return {
      global: calc(ventasData),
      feetcare: calc(dataFC),
      surco: calc(dataSurco),
      dataFC,
      dataSurco
    };
  }, [ventasData]);

  const currentStats = activeTab === 'recepcion' ? stats.feetcare : activeTab === 'surco' ? stats.surco : stats.global;
  const currentData = activeTab === 'recepcion' ? stats.dataFC : activeTab === 'surco' ? stats.dataSurco : ventasData;

  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  return (
    <div className="p-4 md:p-8 font-sans max-w-7xl mx-auto space-y-8 animate-in fade-in pb-32">
      
      {/* 1. SECCIÓN DE FILTROS - ALTA VISIBILIDAD */}
      <div className="bg-white p-8 rounded-[3rem] shadow-2xl border border-slate-100 space-y-8">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
          <div className="flex items-center gap-4">
             <div className="p-4 bg-brand-500 rounded-2xl shadow-lg shadow-brand-500/20"><Filter className="text-white w-6 h-6" /></div>
             <div>
                <h1 className="text-2xl font-black text-slate-900 uppercase tracking-tighter italic">Panel de Auditoría de Ventas</h1>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Sincronizado con: {session?.companyName}</p>
             </div>
          </div>
          <div className="flex gap-3 w-full lg:w-auto">
             <button onClick={fetchData} disabled={loading} className="flex-1 lg:flex-none flex items-center justify-center gap-2 bg-slate-50 px-6 py-4 rounded-xl font-black text-[10px] uppercase border border-slate-200 hover:bg-white transition-all">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-brand-500' : ''}`} /> Sincronizar Odoo
             </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-2 bg-slate-50 rounded-[2.5rem] border border-slate-100">
           {(['hoy', 'mes', 'anio', 'custom'] as FilterMode[]).map(m => (
             <button key={m} onClick={() => setFilterMode(m)} className={`px-6 py-4 rounded-[1.8rem] text-[10px] font-black uppercase tracking-widest transition-all ${filterMode === m ? 'bg-white text-brand-600 shadow-xl scale-[1.02] border border-brand-100' : 'text-slate-400 hover:text-slate-600'}`}>
                {m === 'hoy' ? 'VENTA DEL DÍA' : m === 'mes' ? 'POR MES' : m === 'anio' ? 'ANUAL' : 'PERSONALIZADO'}
             </button>
           ))}
        </div>

        {/* CONTROLES ESPECÍFICOS SEGÚN MODO */}
        <div className="flex flex-col md:flex-row items-center justify-center gap-8 py-2 animate-in slide-in-from-top-4">
           {filterMode === 'mes' && (
              <div className="flex items-center gap-8 bg-white px-8 py-4 rounded-2xl border border-slate-100 shadow-sm">
                 <button onClick={() => setSelectedMonth(m => m === 0 ? 11 : m - 1)} className="p-2 hover:bg-slate-50 rounded-full transition-colors"><ChevronLeft/></button>
                 <div className="text-center min-w-[150px]">
                    <span className="text-[9px] font-black text-slate-400 uppercase block tracking-tighter">Seleccionar Mes</span>
                    <span className="text-lg font-black text-slate-900 uppercase italic">{meses[selectedMonth]} {selectedYear}</span>
                 </div>
                 <button onClick={() => setSelectedMonth(m => m === 11 ? 0 : m + 1)} className="p-2 hover:bg-slate-50 rounded-full transition-colors"><ChevronRight/></button>
              </div>
           )}

           {filterMode === 'hoy' && (
              <div className="flex items-center gap-4 text-brand-600 font-black uppercase bg-brand-50 px-8 py-4 rounded-2xl border border-brand-100">
                 <Clock className="w-5 h-5"/>
                 <span className="text-sm tracking-tighter italic">Reporte de Hoy: {today.toLocaleDateString('es-PE', { day: 'numeric', month: 'long' })}</span>
              </div>
           )}

           {filterMode === 'custom' && (
              <div className="flex items-center gap-4 bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                 <input type="date" value={customRange.start} onChange={e => setCustomRange({...customRange, start: e.target.value})} className="p-2 bg-slate-50 rounded-lg text-xs font-bold" />
                 <ArrowRight size={16} className="text-slate-300"/>
                 <input type="date" value={customRange.end} onChange={e => setCustomRange({...customRange, end: e.target.value})} className="p-2 bg-slate-50 rounded-lg text-xs font-bold" />
              </div>
           )}
        </div>
      </div>

      {/* 2. KPIs DE RENTABILIDAD REAL */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden group">
             <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><ArrowDownToLine className="w-3 h-3"/> Venta Bruta (Caja)</p>
             <h3 className="text-3xl font-black text-slate-900 tracking-tighter">S/ {currentStats.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[9px] font-bold text-slate-400 mt-2 uppercase">Base Neta: S/ {currentStats.vNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</p>
             <Target className="absolute -bottom-4 -right-4 w-24 h-24 text-slate-50 group-hover:text-brand-50 transition-colors" />
          </div>
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
             <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><Calculator className="w-3 h-3"/> Costo Total (Odoo)</p>
             <h3 className={`text-3xl font-black tracking-tighter ${currentStats.cost === 0 ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>S/ {currentStats.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             {currentStats.cost === 0 && <p className="text-[8px] font-black text-rose-600 mt-2 uppercase">⚠️ ALERTA: Sin costos en Odoo</p>}
          </div>
          <div className="bg-slate-900 p-8 rounded-[2.5rem] shadow-xl text-white">
             <p className="text-slate-500 text-[9px] font-black uppercase tracking-widest mb-1">Utilidad Real (Auditada)</p>
             <h3 className="text-3xl font-black tracking-tighter text-brand-400">S/ {currentStats.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[9px] font-black text-white/40 mt-2 uppercase">Margen: {currentStats.rent}%</p>
          </div>
          <div className="bg-brand-500 p-8 rounded-[2.5rem] shadow-xl shadow-brand-500/20 text-white">
             <p className="text-white/70 text-[9px] font-black uppercase tracking-widest mb-1">Utilidad Caja (Con IGV)</p>
             <h3 className="text-3xl font-black tracking-tighter">S/ {currentStats.mBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
          </div>
      </div>

      {/* 3. SELECTOR DE SEDE Y TABLAS */}
      <div className="space-y-6">
        <div className="flex bg-slate-100 p-2 rounded-[2.5rem] border border-slate-200 gap-2 w-full lg:w-fit mx-auto shadow-inner">
            {(['consolidado', 'recepcion', 'surco'] as ReportTab[]).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-10 py-4 rounded-[2rem] font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:text-slate-600'}`}>
                {tab === 'consolidado' ? 'VISTA GLOBAL' : tab === 'recepcion' ? 'FEETCARE / RECEPCIÓN' : 'SURCO'}
              </button>
            ))}
        </div>

        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-xl overflow-hidden">
          <div className="px-10 py-8 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-xl font-black text-slate-900 uppercase tracking-tighter flex items-center gap-3">
              <ReceiptText className="text-brand-500 w-6 h-6" /> Detalle de Auditoría
            </h3>
            <div className="text-right">
              <span className="text-[9px] font-black text-slate-400 uppercase block mb-1">Items Vendidos</span>
              <span className="text-xl font-black text-slate-900">{currentData.length}</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50/50 text-[9px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                <tr>
                  <th className="px-8 py-6">Producto / Auditoría</th>
                  <th className="px-8 py-6 text-right">Venta (Con IGV)</th>
                  <th className="px-8 py-6 text-right">Costo Unit.</th>
                  <th className="px-8 py-6 text-right">Costo Total</th>
                  <th className="px-8 py-6 text-right">Utilidad Neta</th>
                  <th className="px-8 py-6 text-center">Rent %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {currentData.map((v, i) => (
                  <tr key={i} className={`hover:bg-slate-50 transition-all ${v.costo === 0 ? 'bg-rose-50/30' : ''}`}>
                    <td className="px-8 py-5">
                       <p className="font-black text-slate-900 text-[11px] uppercase leading-tight">{v.producto}</p>
                       <p className="text-[8px] text-slate-400 font-bold mt-1 uppercase flex items-center gap-1">
                         {v.costo === 0 && <AlertTriangle size={10} className="text-rose-500"/>}
                         {v.fecha.toLocaleDateString('es-PE')} - {v.sede}
                       </p>
                    </td>
                    <td className="px-8 py-5 text-right font-black text-slate-900 text-xs">S/ {v.total.toFixed(2)}</td>
                    <td className="px-8 py-5 text-right font-bold text-slate-400 text-xs italic">S/ {(v.costo / v.cantidad).toFixed(2)}</td>
                    <td className={`px-8 py-5 text-right font-bold text-xs ${v.costo === 0 ? 'text-rose-500' : 'text-slate-300'}`}>S/ {v.costo.toFixed(2)}</td>
                    <td className="px-8 py-5 text-right font-black text-brand-600 text-xs bg-brand-50/20">S/ {v.margen.toFixed(2)}</td>
                    <td className="px-8 py-5 text-center">
                       <span className={`text-[10px] font-black px-2 py-1 rounded-lg ${Number(v.margenPorcentaje) >= 100 ? 'bg-rose-100 text-rose-700' : 'bg-brand-50 text-brand-700'}`}>
                          {v.margenPorcentaje}%
                       </span>
                    </td>
                  </tr>
                ))}
                {currentData.length === 0 && (
                  <tr><td colSpan={6} className="px-8 py-32 text-center text-slate-300 font-black uppercase tracking-widest italic">No hay datos para mostrar</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {loading && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-brand-500 text-white px-10 py-5 rounded-full shadow-2xl flex items-center gap-4 animate-bounce z-50">
           <Loader2 className="w-5 h-5 animate-spin" />
           <span className="text-xs font-black uppercase tracking-widest italic">{syncProgress}</span>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-100 p-8 rounded-[3rem] flex items-center gap-6 text-rose-600 shadow-xl">
          <AlertCircle className="w-12 h-12" />
          <div>
            <p className="font-black text-sm uppercase tracking-widest mb-1">Error de Conexión Odoo</p>
            <p className="text-xs">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
